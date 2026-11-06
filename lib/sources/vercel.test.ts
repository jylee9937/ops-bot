// 고정 응답은 Vercel 공식 API 문서와 실제 배포 목록의 형식을 따라 만든 가짜 데이터다.
import { describe, expect, it } from "vitest";
import { fakeFetch, jsonResponse } from "./__fixtures__/fake-fetch";
import deployments from "./__fixtures__/vercel-deployments.json";
import { MAX_PAGES } from "./shared";
import { collectVercel } from "./vercel";

const VERCEL = { projectId: "prj_example", productionBranch: "main" };
const CONFIG = { teamId: "team_example", token: "vercel-secret" };
const NOW = new Date("2026-11-07T01:00:00.000Z");
const CURSOR = "2026-11-07T00:55:00.000Z";

function collect(responses: Array<Response | Error>, cursor: string | null = CURSOR) {
  const fetch = fakeFetch(responses);
  const result = collectVercel("site-a", VERCEL, CONFIG, { cursor, now: NOW, fetchImpl: fetch.impl });
  return { fetch, result };
}

function fullPage(next: number | null) {
  const items = Array.from({ length: 100 }, (_, index) => ({
    uid: `dpl_${next}_${index}`,
    created: 1793830000000,
    readyState: "READY",
    target: "production",
  }));
  return jsonResponse({ deployments: items, pagination: { count: 100, next, prev: null } });
}

describe("collectVercel 요청", () => {
  it("production 배포를 읽는다", async () => {
    const { fetch, result } = collect([jsonResponse(deployments)]);
    await result;

    const [url] = fetch.urls;
    expect(url.origin + url.pathname).toBe("https://api.vercel.com/v7/deployments");
    expect(url.searchParams.get("projectId")).toBe("prj_example");
    expect(url.searchParams.get("target")).toBe("production");
    expect(url.searchParams.get("teamId")).toBe("team_example");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(fetch.authorization[0]).toBe("Bearer vercel-secret");
  });

  it("오래 걸린 빌드의 실패를 놓치지 않게 최소 60분을 읽는다", async () => {
    const { fetch, result } = collect([jsonResponse(deployments)]);
    await result;
    expect(fetch.urls[0].searchParams.get("since")).toBe(String(NOW.getTime() - 60 * 60_000));
  });

  it("커서가 더 오래됐으면 커서 10분 전부터 읽는다", async () => {
    const cursor = "2026-11-06T22:00:00.000Z";
    const { fetch, result } = collect([jsonResponse(deployments)], cursor);
    await result;
    expect(fetch.urls[0].searchParams.get("since")).toBe(String(Date.parse(cursor) - 10 * 60_000));
  });

  it("pagination.next를 until로 넘겨 다음 쪽을 읽는다", async () => {
    const { fetch, result } = collect([fullPage(1793820000000), jsonResponse(deployments)]);
    const { deploys, nextCursor } = await result;

    expect(fetch.urls).toHaveLength(2);
    expect(fetch.urls[0].searchParams.has("until")).toBe(false);
    expect(fetch.urls[1].searchParams.get("until")).toBe("1793820000000");
    expect(deploys.length).toBeGreaterThan(100);
    expect(nextCursor).toBe(NOW.toISOString());
  });

  it("next가 없으면 꽉 찬 쪽에서도 멈춘다", async () => {
    const { fetch, result } = collect([fullPage(null)]);
    await result;
    expect(fetch.urls).toHaveLength(1);
  });

  it("쪽 수 상한에 걸리면 커서를 움직이지 않는다", async () => {
    const pages = Array.from({ length: MAX_PAGES + 1 }, (_, index) => fullPage(1793820000000 - index));
    const { fetch, result } = collect(pages);
    const { nextCursor } = await result;

    expect(fetch.urls).toHaveLength(MAX_PAGES);
    expect(nextCursor).toBe(CURSOR);
  });
});

describe("collectVercel 정규화", () => {
  it("모든 production 배포를 타임라인에 남긴다", async () => {
    const { deploys } = await collect([jsonResponse(deployments)]).result;
    expect(deploys).toEqual([
      {
        target: "site-a",
        deploymentId: "dpl_ready",
        sha: "0123456789abcdef0123456789abcdef01234567",
        state: "READY",
        createdAt: new Date(1793840000000).toISOString(),
      },
      {
        target: "site-a",
        deploymentId: "dpl_failed",
        sha: "abcdef0",
        state: "ERROR",
        createdAt: new Date(1793839000000).toISOString(),
      },
      {
        target: "site-a",
        deploymentId: "dpl_other_shape",
        sha: null,
        state: "ERROR",
        createdAt: new Date(1793838000000).toISOString(),
      },
      {
        target: "site-a",
        deploymentId: "dpl_building",
        sha: null,
        state: "BUILDING",
        createdAt: new Date(1793837000000).toISOString(),
      },
    ]);
  });

  it("ERROR만 신호로 만들고 지문은 (배포 id, ERROR)다", async () => {
    const { signals } = await collect([jsonResponse(deployments)]).result;
    expect(signals).toHaveLength(2);
    expect(signals[0]).toEqual({
      target: "site-a",
      source: "vercel",
      kind: "deploy.failed",
      fingerprint: "vercel:dpl_failed:ERROR",
      sourceId: "dpl_failed",
      title: "배포 실패 (BUILD_FAILED)",
      tag: null,
      route: null,
      count: 1,
      users: 0,
      firstSeen: new Date(1793839000000).toISOString(),
      lastSeen: new Date(1793839200000).toISOString(),
      link: "https://vercel.com/example/example/failed",
    });
  });

  it("id·state 형식도 받고, 링크가 없어도 알린다", async () => {
    const { signals } = await collect([jsonResponse(deployments)]).result;
    expect(signals[1]).toMatchObject({
      fingerprint: "vercel:dpl_other_shape:ERROR",
      title: "배포 실패",
      link: "https://vercel.com/dashboard",
    });
  });

  it("preview 실패는 알리지 않는다", async () => {
    const { signals, deploys } = await collect([jsonResponse(deployments)]).result;
    expect(signals.some((signal) => signal.sourceId === "dpl_preview")).toBe(false);
    expect(deploys.some((deploy) => deploy.deploymentId === "dpl_preview")).toBe(false);
  });

  it("형식이 다른 항목은 세어 건너뛴다", async () => {
    const { skipped } = await collect([jsonResponse(deployments)]).result;
    expect(skipped).toBe(2);
  });

  it("커밋 메시지·오류 메시지·작성자를 남기지 않는다", async () => {
    const text = JSON.stringify(await collect([jsonResponse(deployments)]).result);
    for (const raw of ["kim@example.com", "홍길동", "010-1234-5678", "빌드 실패"]) {
      expect(text).not.toContain(raw);
    }
  });
});

describe("collectVercel 실패", () => {
  it.each([
    [401, "auth"],
    [403, "auth"],
    [429, "rate_limit"],
    [500, "server"],
    [404, "bad_request"],
  ])("HTTP %i는 출처 실패 %s", async (status, reason) => {
    const { result } = collect([new Response("{}", { status })]);
    await expect(result).rejects.toMatchObject({ name: "SourceError", source: "vercel", reason, status });
  });

  it("네트워크 실패의 메시지에 토큰을 남기지 않는다", async () => {
    const { result } = collect([new Error("vercel-secret 연결 실패")]);
    const error = await result.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reason: "network" });
    expect(String(error)).not.toContain("vercel-secret");
  });

  it.each([
    ["배포 목록이 없는 본문", jsonResponse({ error: { code: "오류" } })],
    ["pagination이 없는 본문", jsonResponse({ deployments: [] })],
    ["JSON이 아닌 본문", new Response("<html>")],
  ])("%s", async (_name, response) => {
    await expect(collect([response]).result).rejects.toMatchObject({ reason: "invalid_response" });
  });
});
