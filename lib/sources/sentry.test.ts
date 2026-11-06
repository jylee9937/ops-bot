// 고정 응답은 Sentry 공식 API 문서의 형식을 따라 만든 가짜 데이터다. 개인정보도 가짜다.
import { describe, expect, it } from "vitest";
import { fakeFetch, jsonResponse } from "./__fixtures__/fake-fetch";
import latestEvent from "./__fixtures__/sentry-event-latest.json";
import page1 from "./__fixtures__/sentry-issues.page1.json";
import page2 from "./__fixtures__/sentry-issues.page2.json";
import { collectSentry, fetchSentryFrames, fetchSentryIssueStatus } from "./sentry";
import { MAX_PAGES } from "./shared";

const SENTRY = { project: "example-prod", environment: "production" };
const CONFIG = { org: "example-org", token: "sentry-secret" };
const NOW = new Date("2026-11-07T01:00:00.000Z");
const CURSOR = "2026-11-07T00:55:00.000Z";

const LINK_HAS_NEXT =
  '<https://sentry.io/api/0/organizations/example-org/issues/?cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", ' +
  '<https://sentry.io/api/0/organizations/example-org/issues/?cursor=0:100:0>; rel="next"; results="true"; cursor="0:100:0"';
const LINK_LAST =
  '<https://sentry.io/api/0/organizations/example-org/issues/?cursor=0:0:1>; rel="previous"; results="true"; cursor="0:0:1", ' +
  '<https://sentry.io/api/0/organizations/example-org/issues/?cursor=0:200:0>; rel="next"; results="false"; cursor="0:200:0"';

function collect(responses: Array<Response | Error>, cursor: string | null = CURSOR) {
  const fetch = fakeFetch(responses);
  const result = collectSentry("site-a", SENTRY, CONFIG, { cursor, now: NOW, fetchImpl: fetch.impl });
  return { fetch, result };
}

function twoPages() {
  return [
    jsonResponse(page1, { headers: { Link: LINK_HAS_NEXT } }),
    jsonResponse(page2, { headers: { Link: LINK_LAST } }),
  ];
}

describe("collectSentry 요청", () => {
  it("production issue를 커서 10분 전부터 읽는다", async () => {
    const { fetch, result } = collect([jsonResponse([], { headers: { Link: LINK_LAST } })]);
    await result;

    const [url] = fetch.urls;
    expect(url.origin + url.pathname).toBe("https://sentry.io/api/0/organizations/example-org/issues/");
    expect(url.searchParams.get("project")).toBe("example-prod");
    expect(url.searchParams.get("environment")).toBe("production");
    expect(url.searchParams.get("query")).toBe("lastSeen:>2026-11-07T00:45:00Z");
    expect(url.searchParams.get("sort")).toBe("date");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(fetch.authorization[0]).toBe("Bearer sentry-secret");
  });

  it.each([
    ["커서 없음", null],
    ["깨진 커서", "어제쯤"],
  ])("%s이면 첫 실행 구간을 읽는다", async (_name, cursor) => {
    const { fetch, result } = collect([jsonResponse([])], cursor);
    await result;
    expect(fetch.urls[0].searchParams.get("query")).toBe("lastSeen:>2026-11-06T23:50:00Z");
  });

  it("Link 헤더의 다음 커서를 따라가고 results=false에서 멈춘다", async () => {
    const { fetch, result } = collect(twoPages());
    const { signals, nextCursor } = await result;

    expect(fetch.urls).toHaveLength(2);
    expect(fetch.urls[0].searchParams.has("cursor")).toBe(false);
    expect(fetch.urls[1].searchParams.get("cursor")).toBe("0:100:0");
    expect(fetch.urls[1].searchParams.get("query")).toBe("lastSeen:>2026-11-07T00:45:00Z");
    expect(signals.map((signal) => signal.sourceId)).toEqual(["1001", "1002", "1003", "1006", "1007"]);
    expect(nextCursor).toBe(NOW.toISOString());
  });

  it("쪽 수 상한에 걸리면 커서를 움직이지 않는다", async () => {
    const pages = Array.from({ length: MAX_PAGES + 1 }, () =>
      jsonResponse([], { headers: { Link: LINK_HAS_NEXT } }),
    );
    const { fetch, result } = collect(pages);
    const { nextCursor } = await result;

    expect(fetch.urls).toHaveLength(MAX_PAGES);
    expect(nextCursor).toBe(CURSOR);
  });
});

describe("collectSentry 정규화", () => {
  it("예외는 타입만 남기고 누적값은 lifetime을 쓴다", async () => {
    const { signals } = await collect(twoPages()).result;
    expect(signals[0]).toEqual({
      target: "site-a",
      source: "sentry",
      kind: "issue.new",
      fingerprint: "sentry:1001",
      sourceId: "1001",
      title: "TypeError",
      tag: null,
      route: "GET /api/playback/[lectureId]",
      count: 40,
      users: 9,
      firstSeen: "2026-11-07T00:50:00.000Z",
      lastSeen: "2026-11-07T00:58:00.123Z",
      link: "https://sentry.io/organizations/example-org/issues/1001/",
    });
  });

  it("로그 메시지는 태그와 콜론 앞 문구만 남긴다", async () => {
    const { signals } = await collect(twoPages()).result;
    expect(signals[1]).toMatchObject({
      kind: "issue.ongoing",
      title: "[articles] 공개 목록 조회 실패",
      tag: "articles",
      route: "/articles",
      count: 5,
      users: 0,
    });
  });

  it("태그가 있는 예외는 고정 문구를 남기고 resolved를 알려 준다", async () => {
    const { signals } = await collect(twoPages()).result;
    expect(signals[2]).toMatchObject({
      kind: "issue.resolved",
      title: "[auth] 로그인 실패 (Error)",
      tag: "auth",
    });
  });

  it("보관한 issue와 빈 culprit을 처리한다", async () => {
    const { signals } = await collect(twoPages()).result;
    expect(signals[3]).toMatchObject({ kind: "issue.ignored", title: "[cron] 작업 실패", route: null });
  });

  it("재발을 구분하고 DETAIL 줄을 버린다", async () => {
    const { signals } = await collect(twoPages()).result;
    expect(signals[4]).toMatchObject({ kind: "issue.regressed", title: "[inquiry] 저장 실패" });
  });

  it("성능 issue는 빼고, 형식이 다른 항목은 세어 건너뛴다", async () => {
    const { signals, skipped } = await collect(twoPages()).result;
    expect(signals.some((signal) => signal.sourceId === "1004")).toBe(false);
    expect(skipped).toBe(1);
  });

  it("원문이 결과에 남지 않는다", async () => {
    const text = JSON.stringify(await collect(twoPages()).result);
    for (const raw of ["kim@example.com", "홍길동", "010-1234-5678", "secret-token", "DETAIL", "Cannot read"]) {
      expect(text).not.toContain(raw);
    }
  });
});

describe("collectSentry 실패", () => {
  it.each([
    [401, "auth"],
    [403, "auth"],
    [429, "rate_limit"],
    [500, "server"],
    [503, "server"],
    [400, "bad_request"],
  ])("HTTP %i는 출처 실패 %s", async (status, reason) => {
    const { result } = collect([new Response("{}", { status })]);
    await expect(result).rejects.toMatchObject({ name: "SourceError", source: "sentry", reason, status });
  });

  it("네트워크 실패의 메시지에 URL과 토큰을 남기지 않는다", async () => {
    const { result } = collect([new Error("https://sentry.io/?token=sentry-secret 연결 실패")]);
    const error = await result.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "SourceError", reason: "network" });
    expect(String(error)).not.toMatch(/sentry-secret|sentry\.io/);
  });

  it("중단 신호를 fetch에 넘긴다", async () => {
    const fetch = fakeFetch([]);
    const result = collectSentry("site-a", SENTRY, CONFIG, {
      cursor: CURSOR,
      now: NOW,
      fetchImpl: fetch.impl,
      signal: AbortSignal.abort(),
    });
    await expect(result).rejects.toMatchObject({ reason: "network" });
  });

  it.each([
    ["배열이 아닌 본문", jsonResponse({ detail: "오류" })],
    ["JSON이 아닌 본문", new Response("<html>")],
  ])("%s", async (_name, response) => {
    await expect(collect([response]).result).rejects.toMatchObject({ reason: "invalid_response" });
  });
});

describe("fetchSentryFrames", () => {
  it("실제로 던져진 예외의 앱 프레임을 호출 지점부터 5개 돌려준다", async () => {
    const fetch = fakeFetch([jsonResponse(latestEvent)]);
    const frames = await fetchSentryFrames(SENTRY, CONFIG, "1001", { fetchImpl: fetch.impl });

    expect(fetch.urls[0].pathname).toBe("/api/0/organizations/example-org/issues/1001/events/latest/");
    expect(fetch.urls[0].searchParams.get("environment")).toBe("production");
    expect(frames).toEqual([
      { filename: "/_next/static/app.js", function: "submit", line: 7 },
      { filename: "app/a6.ts", function: "a6", line: 6 },
      { filename: "app/a5.ts", function: "a5", line: 5 },
      { filename: "app/a4.ts", function: "a4", line: 4 },
      { filename: "app/a3.ts", function: "a3", line: 3 },
    ]);
  });

  it("소스 코드·변수·태그·breadcrumb을 남기지 않는다", async () => {
    const fetch = fakeFetch([jsonResponse(latestEvent)]);
    const frames = await fetchSentryFrames(SENTRY, CONFIG, "1001", { fetchImpl: fetch.impl });
    const text = JSON.stringify(frames);
    for (const raw of ["kim@example.com", "secret-token", "site.example"]) {
      expect(text).not.toContain(raw);
    }
  });

  it("앱 프레임이 없으면 전체 프레임을 쓴다", async () => {
    const event = {
      entries: [
        {
          type: "exception",
          data: {
            values: [
              { stacktrace: { frames: [{ filename: "node_modules/a.js", function: "a", lineNo: 1, inApp: false }] } },
            ],
          },
        },
      ],
    };
    const fetch = fakeFetch([jsonResponse(event)]);
    const frames = await fetchSentryFrames(SENTRY, CONFIG, "1001", { fetchImpl: fetch.impl });
    expect(frames).toEqual([{ filename: "node_modules/a.js", function: "a", line: 1 }]);
  });

  it.each([
    ["예외가 없는 이벤트", { entries: [{ type: "message", data: { formatted: "로그" } }] }],
    ["스택이 없는 예외", { entries: [{ type: "exception", data: { values: [{ type: "Error", stacktrace: null }] } }] }],
    ["형식이 다른 본문", { entries: "없음" }],
  ])("%s는 빈 목록", async (_name, body) => {
    const fetch = fakeFetch([jsonResponse(body)]);
    await expect(fetchSentryFrames(SENTRY, CONFIG, "1001", { fetchImpl: fetch.impl })).resolves.toEqual([]);
  });

  it("인증 실패는 호출한 쪽에 알린다", async () => {
    const fetch = fakeFetch([new Response("{}", { status: 401 })]);
    await expect(fetchSentryFrames(SENTRY, CONFIG, "1001", { fetchImpl: fetch.impl })).rejects.toMatchObject({
      reason: "auth",
    });
  });
});

describe("fetchSentryIssueStatus", () => {
  it.each([
    ["unresolved", "unresolved"],
    ["resolved", "resolved"],
    ["ignored", "ignored"],
    ["reprocessing", "other"],
  ])("%s → %s", async (status, expected) => {
    const fetch = fakeFetch([jsonResponse({ id: "1001", status })]);
    await expect(fetchSentryIssueStatus(CONFIG, "1001", { fetchImpl: fetch.impl })).resolves.toBe(expected);
    expect(fetch.urls[0].pathname).toBe("/api/0/organizations/example-org/issues/1001/");
  });

  it("지워진 issue는 missing", async () => {
    const fetch = fakeFetch([new Response("{}", { status: 404 })]);
    await expect(fetchSentryIssueStatus(CONFIG, "1001", { fetchImpl: fetch.impl })).resolves.toBe("missing");
  });

  it("다른 실패는 호출한 쪽에 알린다", async () => {
    const fetch = fakeFetch([new Response("{}", { status: 429 })]);
    await expect(fetchSentryIssueStatus(CONFIG, "1001", { fetchImpl: fetch.impl })).rejects.toMatchObject({
      reason: "rate_limit",
    });
  });

  it("상태가 없는 본문은 형식 오류", async () => {
    const fetch = fakeFetch([jsonResponse({ id: "1001" })]);
    await expect(fetchSentryIssueStatus(CONFIG, "1001", { fetchImpl: fetch.impl })).rejects.toMatchObject({
      reason: "invalid_response",
    });
  });
});
