// 고정 응답은 UptimeRobot v3 실제 응답(2026-11-10, Read-only 키)의 형식을 따라 만든 가짜 데이터다.
import { describe, expect, it } from "vitest";
import { fakeFetch, jsonResponse } from "./__fixtures__/fake-fetch";
import monitors from "./__fixtures__/uptimerobot-monitors.json";
import { SourceError } from "./shared";
import {
  fetchUptimeMonitors,
  isRecovered,
  monitorsFor,
  uptimeSignals,
  type UptimeMonitor,
} from "./uptimerobot";

const CONFIG = { apiKey: "ur-test-secret" };
const NOW = new Date("2026-11-10T10:13:00.000Z");
const HOSTS = ["site-a.example"];

function fetchList(responses: Array<Response | Error>) {
  const fetch = fakeFetch(responses);
  return { fetch, result: fetchUptimeMonitors(CONFIG, { now: NOW, fetchImpl: fetch.impl }) };
}

function monitor(overrides: Partial<UptimeMonitor> = {}): UptimeMonitor {
  return {
    id: 1,
    host: "site-a.example",
    status: "UP",
    route: "/" as UptimeMonitor["route"],
    downSince: null,
    reason: null,
    ...overrides,
  };
}

describe("fetchUptimeMonitors", () => {
  it("v3 감시 목록을 Read-only 키로 읽는다", async () => {
    const { fetch, result } = fetchList([jsonResponse(monitors)]);
    const list = await result;

    const [url] = fetch.urls;
    expect(url.origin + url.pathname).toBe("https://api.uptimerobot.com/v3/monitors");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(fetch.authorization[0]).toBe("Bearer ur-test-secret");
    expect(list.monitors).toHaveLength(5);
    expect(list.complete).toBe(true);
    expect(list.skipped).toBe(0);
  });

  it("감시 이름(사용자가 쓴 글)은 담지 않고 호스트·경로만 남긴다", async () => {
    const { result } = fetchList([jsonResponse(monitors)]);
    const list = await result;

    expect(JSON.stringify(list)).not.toContain("kim@example.com");
    expect(JSON.stringify(list)).not.toContain("재생 점검");
    const down = list.monitors.find(({ id }) => id === 900000003);
    expect(down).toMatchObject({
      host: "site-a.example",
      status: "DOWN",
      // 쿼리는 뗀다
      route: "/api/health-wrong",
      downSince: "2026-11-10T10:12:24.440Z",
      reason: "404 Not Found",
    });
  });

  it("다운이 아닌 감시에는 시작 시각과 사유를 두지 않는다", async () => {
    const { result } = fetchList([jsonResponse(monitors)]);
    const up = (await result).monitors.find(({ id }) => id === 900000001);
    expect(up).toMatchObject({ status: "UP", downSince: null, reason: null });
  });

  it("진행 중인 incident가 없으면 지금 상태가 이어진 시간으로 시작 시각을 계산한다", async () => {
    const body = {
      data: [{ id: 7, url: "https://site-a.example/", status: "DOWN", currentStateDuration: 120, lastIncident: null }],
    };
    const { result } = fetchList([jsonResponse(body)]);
    expect((await result).monitors[0].downSince).toBe("2026-11-10T10:11:00.000Z");
  });

  it("지난(해결된) incident의 시작 시각은 쓰지 않는다", async () => {
    const body = {
      data: [
        {
          id: 7,
          url: "https://site-a.example/",
          status: "DOWN",
          currentStateDuration: 60,
          lastIncident: { status: "Resolved", startedAt: "2026-11-01T00:00:00.000Z", cause: 500 },
        },
      ],
    };
    const { result } = fetchList([jsonResponse(body)]);
    expect((await result).monitors[0].downSince).toBe("2026-11-10T10:12:00.000Z");
  });

  it.each([
    ["사유 문구", { cause: 404, reason: "404 Not Found" }, "404 Not Found"],
    ["형식이 다른 사유는 HTTP 코드로", { cause: 503, reason: "<script>alert(1)</script>" }, "HTTP 503"],
    ["코드가 문자열", { cause: "502", reason: null }, "HTTP 502"],
    ["HTTP 코드가 아닌 원인", { cause: 9999, reason: "" }, null],
  ])("사유: %s", async (_label, incident, expected) => {
    const body = {
      data: [
        {
          id: 7,
          url: "https://site-a.example/",
          status: "DOWN",
          lastIncident: { status: "Ongoing", startedAt: "2026-11-10T10:00:00.000Z", ...incident },
        },
      ],
    };
    const { result } = fetchList([jsonResponse(body)]);
    expect((await result).monitors[0].reason).toBe(expected);
  });

  it("형식이 다른 항목은 건너뛰고 센다", async () => {
    const body = { data: [{ id: "x", url: "https://site-a.example/" }, monitors.data[0]] };
    const { result } = fetchList([jsonResponse(body)]);
    const list = await result;
    expect(list.monitors).toHaveLength(1);
    expect(list.skipped).toBe(1);
  });

  it("다음 쪽(nextLink)을 같은 API에서만 따라간다", async () => {
    const next = "https://api.uptimerobot.com/v3/monitors?limit=50&cursor=900000003";
    const { fetch, result } = fetchList([
      jsonResponse({ data: [monitors.data[0]], nextLink: next }),
      jsonResponse({ data: [monitors.data[1]] }),
    ]);
    const list = await result;
    expect(fetch.urls.map(String)).toEqual(["https://api.uptimerobot.com/v3/monitors?limit=50", next]);
    expect(fetch.authorization).toEqual(["Bearer ur-test-secret", "Bearer ur-test-secret"]);
    expect(list.monitors).toHaveLength(2);
    expect(list.complete).toBe(true);
  });

  it("다른 곳을 가리키는 다음 쪽 주소에는 키를 보내지 않는다", async () => {
    const { fetch, result } = fetchList([
      jsonResponse({ data: [], nextLink: "https://evil.example/v3/monitors?limit=50" }),
    ]);
    await expect(result).rejects.toMatchObject({ reason: "invalid_response" });
    expect(fetch.urls).toHaveLength(1);
  });

  it("쪽 수 상한에 닿으면 목록을 다 읽지 못한 것으로 표시한다", async () => {
    const next = "https://api.uptimerobot.com/v3/monitors?limit=50&cursor=1";
    const page = () => jsonResponse({ data: [], nextLink: next });
    const { fetch, result } = fetchList([page(), page(), page(), page()]);
    const list = await result;
    expect(fetch.urls).toHaveLength(4);
    expect(list.complete).toBe(false);
  });

  it.each([
    [401, "auth"],
    [429, "rate_limit"],
    [500, "server"],
  ])("응답 %i은 %s 실패로 던지고 키·본문을 담지 않는다", async (status, reason) => {
    const { result } = fetchList([jsonResponse({ message: "Invalid token." }, { status })]);
    const error = await result.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SourceError);
    expect(error).toMatchObject({ source: "uptimerobot", reason });
    expect(String(error)).not.toContain("ur-test-secret");
    expect(String(error)).not.toContain("Invalid token");
  });

  it("목록 형식이 다르면 invalid_response로 던진다", async () => {
    const { result } = fetchList([jsonResponse({ monitors: [] })]);
    await expect(result).rejects.toMatchObject({ reason: "invalid_response" });
  });
});

describe("monitorsFor", () => {
  it("호스트가 정확히 같은 감시만 고른다", () => {
    const list = [
      monitor({ id: 1, host: "site-a.example" }),
      monitor({ id: 2, host: "www.site-a.example" }),
      monitor({ id: 3, host: "other.example" }),
      monitor({ id: 4, host: null }),
    ];
    expect(monitorsFor(HOSTS, list).map(({ id }) => id)).toEqual([1]);
  });
});

describe("uptimeSignals", () => {
  it("DOWN 감시를 시작 시각으로 고정한 신호로 만든다", () => {
    const [signal, ...rest] = uptimeSignals("site-a", [
      monitor({ id: 9, status: "UP" }),
      monitor({
        id: 10,
        status: "DOWN",
        route: "/api/health" as UptimeMonitor["route"],
        downSince: "2026-11-10T10:12:24.440Z",
        reason: "404 Not Found",
      }),
      monitor({ id: 11, status: "STARTED" }),
    ]);

    expect(rest).toHaveLength(0);
    expect(signal).toEqual({
      target: "site-a",
      source: "uptimerobot",
      kind: "uptime.down",
      fingerprint: "uptime:10",
      sourceId: "10",
      title: "외부 감시 다운 (404 Not Found)",
      tag: null,
      route: "/api/health",
      count: 1,
      users: 0,
      firstSeen: "2026-11-10T10:12:24.440Z",
      lastSeen: "2026-11-10T10:12:24.440Z",
      link: "https://dashboard.uptimerobot.com/monitors/10",
    });
  });

  it("사유가 없으면 제목에 괄호를 붙이지 않는다", () => {
    const [signal] = uptimeSignals("site-a", [
      monitor({ status: "DOWN", downSince: "2026-11-10T10:00:00.000Z", reason: null }),
    ]);
    expect(signal.title).toBe("외부 감시 다운");
  });
});

describe("isRecovered", () => {
  const full = { complete: true, skipped: 0 };
  it.each([
    ["UP", monitor({ status: "UP" }), full, true],
    ["멈춤", monitor({ status: "PAUSED" }), full, true],
    ["여전히 DOWN", monitor({ status: "DOWN" }), full, false],
    ["준비 중", monitor({ status: "STARTED" }), full, false],
    ["목록에서 사라짐(빠짐없이 읽음)", undefined, full, true],
    ["목록에서 사라짐(다 못 읽음)", undefined, { complete: false, skipped: 0 }, false],
    ["[리뷰 P2] 목록에서 사라짐(건너뛴 항목 있음)", undefined, { complete: true, skipped: 1 }, false],
  ])("%s", (_label, value, list, expected) => {
    expect(isRecovered(value, list)).toBe(expected);
  });
});

describe("[리뷰 P2] 시작 시각을 알 수 없는 다운", () => {
  it("incident도 지속 시간도 없으면 새 다운으로 만들지 않고 형식이 다른 항목으로 센다", async () => {
    const body = { data: [{ id: 7, url: "https://site-a.example/", status: "DOWN", lastIncident: null }] };
    const { result } = fetchList([jsonResponse(body)]);
    const list = await result;
    expect(list.monitors).toHaveLength(0);
    expect(list.skipped).toBe(1);
  });
});
