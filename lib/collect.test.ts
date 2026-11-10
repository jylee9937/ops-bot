import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { createTestDb } from "./__fixtures__/test-db";
import { DAILY_ANALYSIS_LIMIT, type ClaudeClient } from "./analysis";
import { reasonOf, rotate, runCollect, STATUS_CHECK_LIMIT, type CollectDeps } from "./collect";
import { acquireLock, getCursor, ingest, listPending, reserveAnalysisCall } from "./incidents";
import { maskLogMessage } from "./mask";
import { SlackError } from "./slack";
import { SourceError } from "./sources/shared";
import type { Target } from "./targets";

const at = (time: string) => new Date(`2026-11-09T${time}:00.000Z`);
const HEARTBEAT = "https://hc-ping.example/check-1";

const TARGET: Target = {
  id: "site-a",
  name: "사이트 A",
  vercel: { projectId: "prj_a", productionBranch: "main" },
  sentry: { project: "site-a-prod", environment: "production" },
  slackChannel: "#ops-a",
  areas: [{ name: "공개 조회", severity: "P2", match: ["articles"] }],
};
const NO_SENTRY: Target = { ...TARGET, id: "site-b", name: "사이트 B", sentry: undefined, slackChannel: "#ops-b" };

function sentryIssue(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Error: [articles] 목록 조회 실패 ${id}`,
    culprit: "/articles",
    count: "1",
    userCount: 0,
    firstSeen: "2026-11-09T00:58:00Z",
    lastSeen: "2026-11-09T00:58:00Z",
    permalink: `https://sentry.io/issues/${id}/`,
    status: "unresolved",
    substatus: "new",
    issueCategory: "error",
    metadata: { type: "Error", value: `[articles] 목록 조회 실패 ${id}` },
    ...overrides,
  };
}

function deployment(id: string, state: string) {
  return {
    uid: id,
    created: at("00:50").getTime(),
    ready: at("00:55").getTime(),
    readyState: state,
    target: "production",
    errorCode: state === "ERROR" ? "BUILD_FAILED" : null,
    inspectorUrl: `https://vercel.com/team/project/${id}`,
    meta: { githubCommitSha: "abcdef0" },
  };
}

/** `method`에 넘긴 문장에 `match`가 들어 있으면 실패하거나(기본) 끝나지 않는 DB. 나머지는 그대로 통과시킨다. */
function failingDb(db: Client, method: "batch" | "execute", match: string, mode: "reject" | "hang" = "reject"): Client {
  return new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === method) {
        return async (...args: unknown[]) => {
          if (JSON.stringify(args[0]).includes(match)) {
            if (mode === "hang") return new Promise(() => {});
            throw new Error("db down");
          }
          return (value as (...rest: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** 주소로 Sentry·Vercel·Slack·heartbeat를 구분해 응답하는 가짜 세상. */
function world() {
  const state = {
    sentryIssues: [] as unknown[],
    sentryStatus: {} as Record<string, string | number>,
    deployments: [] as unknown[],
    fail: {} as { sentry?: number; vercel?: number; slack?: string; heartbeat?: number; uptime?: number },
    sentryEvents: {} as Record<string, unknown>,
    uptimeMonitors: [] as unknown[],
    uptimeNextLink: null as string | null,
  };
  const calls: string[] = [];
  const slack: { channel: string; text: string; body: string }[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  const impl: typeof fetch = async (input, init) => {
    if (init?.signal?.aborted) throw init.signal.reason;
    const url = new URL(String(input));
    if (url.href === HEARTBEAT) {
      calls.push("heartbeat");
      return new Response("OK", { status: state.fail.heartbeat ?? 200 });
    }
    if (url.hostname === "sentry.io") {
      if (url.pathname.endsWith("/issues/")) {
        calls.push("sentry:list");
        return state.fail.sentry ? json({}, state.fail.sentry) : json(state.sentryIssues);
      }
      const event = /\/issues\/([^/]+)\/events\/latest\/$/.exec(url.pathname)?.[1];
      if (event !== undefined) {
        calls.push(`sentry:event:${event}`);
        return json(state.sentryEvents[event] ?? {});
      }
      const id = /\/issues\/([^/]+)\/$/.exec(url.pathname)?.[1] ?? "";
      calls.push(`sentry:status:${id}`);
      const status = state.sentryStatus[id] ?? "unresolved";
      return typeof status === "number" ? json({}, status) : json({ id, status });
    }
    if (url.hostname === "api.uptimerobot.com") {
      calls.push("uptime");
      if (state.fail.uptime) return json({}, state.fail.uptime);
      return json({ data: state.uptimeMonitors, ...(state.uptimeNextLink ? { nextLink: state.uptimeNextLink } : {}) });
    }
    if (url.hostname === "api.vercel.com") {
      calls.push("vercel");
      return state.fail.vercel ? json({}, state.fail.vercel) : json({ deployments: state.deployments, pagination: { next: null } });
    }
    if (url.hostname === "slack.com") {
      calls.push("slack");
      if (state.fail.slack) return json({ ok: false, error: state.fail.slack });
      const body = JSON.parse(String(init?.body));
      slack.push({ channel: body.channel, text: body.text, body: JSON.stringify(body.blocks) });
      return json({ ok: true, ts: `1700000000.${String(slack.length).padStart(6, "0")}` });
    }
    throw new Error(`예상하지 못한 요청: ${url.hostname}`);
  };
  return { state, calls, slack, impl };
}

describe("runCollect", () => {
  let db: Client;
  let cleanup: () => void;
  let w: ReturnType<typeof world>;

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    w = world();
  });
  afterEach(() => cleanup());

  const deps = (time: string, overrides: Partial<CollectDeps> = {}): CollectDeps => ({
    db,
    targets: [TARGET],
    sentry: { org: "example-org", token: "sentry-test-token" },
    vercel: { teamId: "team_test", token: "vercel-test-token" },
    slack: { token: "xoxb-test-token", ownerUserId: "U0OWNER1" },
    heartbeatUrl: HEARTBEAT,
    anthropicApiKey: null,
    fetchImpl: w.impl,
    sleep: async () => {},
    now: () => at(time),
    ...overrides,
  });

  it("배포 실패와 Sentry issue를 incident로 만들어 Slack으로 보내고 heartbeat를 보낸다", async () => {
    w.state.deployments = [deployment("dpl_1", "ERROR"), deployment("dpl_0", "READY")];
    w.state.sentryIssues = [sentryIssue("101")];

    const result = await runCollect(deps("01:00"));

    expect(result.status).toBe("done");
    expect(result.steps).toEqual([
      { target: "site-a", step: "vercel", ok: true, received: 2, skipped: 0 },
      { target: "site-a", step: "sentry", ok: true, received: 1, skipped: 0 },
      { target: "site-a", step: "sentry-status", ok: true },
      { target: "site-a", step: "slack", ok: true },
    ]);
    expect(result.ingested.created).toBe(2);
    expect(result.delivered).toEqual({ detailed: 2, bundled: 0, skipped: 0, analyzed: 0, analysisFailed: 0 });
    expect(w.slack.map((m) => m.channel)).toEqual(["#ops-a", "#ops-a"]);
    expect(w.slack[0].text).toContain("[P1][사이트 A] 배포 실패 (BUILD_FAILED)");
    expect(result.heartbeat).toBe("sent");
    expect(await getCursor(db, "site-a", "sentry")).toBe(at("01:00").toISOString());
    expect(await getCursor(db, "site-a", "vercel")).toBe(at("01:00").toISOString());
  });

  it("빈 DB에서도 스키마를 먼저 만들고 실행한다", async () => {
    const fresh = await createTestDb({ migrated: false });
    try {
      w.state.sentryIssues = [sentryIssue("101")];
      const result = await runCollect(deps("01:00", { db: fresh.db }));
      expect(result.status).toBe("done");
      expect(result.ingested.created).toBe(1);
    } finally {
      fresh.cleanup();
    }
  });

  it("배포를 Sentry보다 먼저 기록해 배포 직후 에러에 표시를 붙인다", async () => {
    // 00:55에 공개된 배포, 00:58에 처음 생긴 에러
    w.state.deployments = [deployment("dpl_1", "READY")];
    w.state.sentryIssues = [sentryIssue("101")];

    await runCollect(deps("01:00"));
    expect(w.slack).toHaveLength(1);
    expect(w.slack[0].body).toContain("배포 직후: 11/09 09:55에 공개된 배포 abcdef0");
  });

  it("같은 실행을 두 번 해도 알림은 한 번만 나간다", async () => {
    w.state.deployments = [deployment("dpl_1", "ERROR")];
    w.state.sentryIssues = [sentryIssue("101")];

    await runCollect(deps("01:00"));
    const second = await runCollect(deps("01:05"));

    expect(w.slack).toHaveLength(2);
    expect(second.delivered.detailed).toBe(0);
    expect(second.heartbeat).toBe("sent");
  });

  it("Sentry가 실패해도 Vercel·Slack은 계속하고, 커서는 그대로 두고, heartbeat는 보내지 않는다", async () => {
    w.state.deployments = [deployment("dpl_1", "ERROR")];
    w.state.sentryIssues = [sentryIssue("101")];
    w.state.fail.sentry = 500;

    const result = await runCollect(deps("01:00"));

    expect(result.steps).toEqual([
      { target: "site-a", step: "vercel", ok: true, received: 1, skipped: 0 },
      { target: "site-a", step: "sentry", ok: false, reason: "server" },
      { target: "site-a", step: "slack", ok: true },
    ]);
    // 수집이 실패했으니 Sentry 해결 확인도 하지 않는다
    expect(w.calls.filter((c) => c.startsWith("sentry:status") || c.startsWith("sentry:event"))).toEqual([]);
    expect(w.slack).toHaveLength(1);
    expect(await getCursor(db, "site-a", "sentry")).toBeNull();
    expect(result.heartbeat).toBe("skipped");
    expect(w.calls).not.toContain("heartbeat");

    // 다음 실행이 같은 구간을 다시 읽어 빠진 issue를 잡는다
    w.state.fail.sentry = undefined;
    const next = await runCollect(deps("01:05"));
    expect(next.ingested.created).toBe(1);
    expect(next.heartbeat).toBe("sent");
  });

  it("형식이 다른 issue는 건너뛰되 그 단계를 실패로 남겨 heartbeat를 막는다", async () => {
    // collapse=stats 응답처럼 count·userCount·firstSeen·lastSeen이 빠진 issue
    const stripped = Object.fromEntries(
      Object.entries(sentryIssue("900")).filter(([key]) => !["count", "userCount", "firstSeen", "lastSeen"].includes(key)),
    );
    w.state.sentryIssues = [stripped, sentryIssue("101")];

    const result = await runCollect(deps("01:00"));

    expect(result.steps[1]).toEqual({
      target: "site-a",
      step: "sentry",
      ok: false,
      reason: "invalid_items",
      received: 1,
      skipped: 1,
    });
    // 요청은 성공했으니 나머지는 처리하고 해결 확인도 한다
    expect(result.ingested.created).toBe(1);
    expect(result.steps.map((s) => s.step)).toContain("sentry-status");
    // [리뷰 P2-2] 커서를 옮기지 않는다. 옮기면 그 항목이 다시 읽히지 않아 15분 뒤 heartbeat가 저절로 돌아온다
    expect(await getCursor(db, "site-a", "sentry")).toBeNull();
    expect(result.heartbeat).toBe("skipped");

    const later = await runCollect(deps("01:20"));
    expect(later.steps[1]).toMatchObject({ ok: false, reason: "invalid_items" });
    expect(later.heartbeat).toBe("skipped");
    expect(w.slack).toHaveLength(1);

    // 형식이 맞게 바뀌면 커서가 옮겨지고 heartbeat가 돌아온다
    w.state.sentryIssues = [sentryIssue("101")];
    const fixed = await runCollect(deps("01:25"));
    expect(fixed.heartbeat).toBe("sent");
    expect(await getCursor(db, "site-a", "sentry")).toBe(at("01:25").toISOString());
  });

  it("[리뷰 P2-2] 형식이 다른 배포가 있으면 Vercel 커서도 옮기지 않는다", async () => {
    w.state.deployments = [{ created: at("00:50").getTime(), target: "production" }, deployment("dpl_1", "READY")];
    const result = await runCollect(deps("01:00"));
    expect(result.steps[0]).toMatchObject({ step: "vercel", ok: false, reason: "invalid_items", received: 1, skipped: 1 });
    expect(await getCursor(db, "site-a", "vercel")).toBeNull();
  });

  it("[리뷰 P2-1] 설정에서 뺀 사이트의 못 보낸 알림은 heartbeat를 막지 않는다", async () => {
    const OLD: Target = { ...NO_SENTRY, id: "site-old", slackChannel: "#ops-old" };
    w.state.deployments = [deployment("dpl_old", "ERROR")];
    w.state.fail.slack = "invalid_auth";
    await runCollect(deps("01:00", { targets: [OLD], sentry: null }));

    // 운영자가 site-old를 설정에서 뺐다. 그 incident는 더 보낼 곳이 없다
    w.state.deployments = [];
    w.state.fail.slack = undefined;
    const result = await runCollect(deps("01:20"));
    expect(result.heartbeat).toBe("sent");
  });

  it("[리뷰 P3-2] 예산이 끝나도 보내는 중인 Slack 전송은 끊지 않아 다음 실행이 다시 보내지 않는다", async () => {
    w.state.sentryIssues = [sentryIssue("101")];
    const slowSlack: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname !== "slack.com") return w.impl(input, init);
      const body = JSON.parse(String(init?.body));
      w.slack.push({ channel: body.channel, text: body.text, body: "" }); // Slack은 받았다
      await new Promise((resolve) => setTimeout(resolve, 80));
      if (init?.signal?.aborted) throw init.signal.reason; // 응답 전에 끊김
      return new Response(JSON.stringify({ ok: true, ts: "1700000000.000001" }));
    };

    await runCollect(deps("01:00", { fetchImpl: slowSlack, budgetMs: 40 }));
    await runCollect(deps("01:05"));
    expect(w.slack).toHaveLength(1);
  });

  it("[리뷰 P3-2] 예산이 끝나면 새 Slack 전송은 시작하지 않고 다음 실행에 맡긴다", async () => {
    w.state.sentryIssues = [sentryIssue("101"), sentryIssue("102")];
    const result = await runCollect(deps("01:00", { budgetMs: 0 }));
    expect(w.slack).toHaveLength(0);
    expect(result.steps.find((s) => s.step === "slack")).toMatchObject({ ok: false, reason: "timeout" });
    expect(await listPending(db, "site-a", at("01:01"))).toHaveLength(2);
  });

  it("[리뷰 P3-4] 모든 사이트를 먼저 수집한 뒤 Slack으로 보낸다", async () => {
    w.state.deployments = [deployment("dpl_1", "ERROR")];
    await runCollect(deps("01:00", { targets: [TARGET, NO_SENTRY] }));
    const firstSlack = w.calls.indexOf("slack");
    const lastCollect = w.calls.findLastIndex((c) => c !== "slack" && c !== "heartbeat");
    expect(firstSlack).toBeGreaterThan(lastCollect);
  });

  it("[리뷰 P3-3] 빈 DB에서 두 실행이 겹쳐도 실패하지 않는다", async () => {
    const fresh = await createTestDb({ migrated: false });
    try {
      const results = await Promise.all([
        runCollect(deps("01:00", { db: fresh.db, holder: "run-a" })),
        runCollect(deps("01:00", { db: fresh.connect(), holder: "run-b" })),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(["done", "locked"]);
    } finally {
      fresh.cleanup();
    }
  });

  it("[리뷰 P3-8] id 형식이 다른 incident는 Sentry 해결 확인을 건너뛴다", async () => {
    const title = maskLogMessage("[articles] 이상한 id");
    await ingest(
      db,
      TARGET,
      [
        {
          target: "site-a",
          source: "sentry",
          kind: "issue.new",
          fingerprint: "sentry:../x",
          sourceId: "../x",
          title,
          tag: null,
          route: null,
          count: 1,
          users: 0,
          firstSeen: at("00:58").toISOString(),
          lastSeen: at("00:58").toISOString(),
          link: "https://sentry.io/issues/x/",
        },
      ],
      at("01:00"),
    );
    w.state.sentryStatus = { "..": 404, x: 404 };
    await runCollect(deps("01:05"));
    expect(w.calls.filter((c) => c.startsWith("sentry:status") || c.startsWith("sentry:event"))).toEqual([]);
    const { rows } = await db.execute("SELECT status FROM incidents WHERE fingerprint = 'sentry:../x'");
    expect(rows[0].status).toBe("open");
  });

  it("Vercel이 실패해도 Sentry는 계속하고 heartbeat는 보내지 않는다", async () => {
    w.state.sentryIssues = [sentryIssue("101")];
    w.state.fail.vercel = 401;

    const result = await runCollect(deps("01:00"));
    expect(result.steps[0]).toEqual({ target: "site-a", step: "vercel", ok: false, reason: "auth" });
    expect(result.ingested.created).toBe(1);
    expect(result.heartbeat).toBe("skipped");
    expect(await getCursor(db, "site-a", "vercel")).toBeNull();
  });

  it("Slack이 실패하면 바로는 heartbeat를 보내고, 못 보낸 알림이 15분 넘게 쌓이면 멈춘다", async () => {
    w.state.sentryIssues = [sentryIssue("101")];
    w.state.fail.slack = "invalid_auth";

    const first = await runCollect(deps("01:00"));
    expect(first.steps.at(-1)).toEqual({ target: "site-a", step: "slack", ok: false, reason: "auth" });
    expect(first.heartbeat).toBe("sent");

    const later = await runCollect(deps("01:16"));
    expect(later.heartbeat).toBe("skipped");
    expect(await listPending(db, "site-a", at("01:16"))).toHaveLength(1);
  });

  it("다른 실행이 잠금을 잡고 있으면 아무것도 하지 않는다", async () => {
    await acquireLock(db, "collect", "other-run", at("01:00"));
    const result = await runCollect(deps("01:01"));

    expect(result).toMatchObject({ status: "locked", steps: [], heartbeat: "skipped" });
    expect(w.calls).toEqual([]);
  });

  it("끝나면 잠금을 푼다", async () => {
    await runCollect(deps("01:00"));
    expect(await acquireLock(db, "collect", "other-run", at("01:00"))).toBe(true);
  });

  it("Sentry에서 해결·보관·삭제된 열린 incident를 닫는다", async () => {
    w.state.sentryIssues = ["101", "102", "103", "104"].map((id) => sentryIssue(id));
    await runCollect(deps("01:00"));

    w.state.sentryIssues = [];
    w.state.sentryStatus = { "101": "resolved", "102": "ignored", "103": 404, "104": "unresolved" };
    const result = await runCollect(deps("01:05"));

    expect(result.ingested.resolved).toBe(3);
    const { rows } = await db.execute("SELECT fingerprint, status FROM incidents ORDER BY fingerprint");
    expect(rows.map((r) => `${r.fingerprint}:${r.status}`)).toEqual([
      "sentry:101:resolved",
      "sentry:102:resolved",
      "sentry:103:resolved",
      "sentry:104:open",
    ]);
  });

  it("열린 incident가 많으면 실행마다 나눠서 모두 확인한다", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => String(200 + i));
    w.state.sentryIssues = ids.map((id) => sentryIssue(id));
    await runCollect(deps("01:00"));
    w.state.sentryIssues = [];

    const checked = new Set<string>();
    for (const time of ["01:05", "01:10"]) {
      w.calls.length = 0;
      await runCollect(deps(time));
      const run = w.calls.filter((c) => c.startsWith("sentry:status:"));
      expect(run.length).toBe(STATUS_CHECK_LIMIT);
      for (const call of run) checked.add(call.replace("sentry:status:", ""));
    }
    expect([...checked].sort()).toEqual(ids);
  });

  it("Sentry가 없는 사이트는 Vercel과 Slack만 한다", async () => {
    w.state.deployments = [deployment("dpl_9", "ERROR")];
    const result = await runCollect(deps("01:00", { targets: [NO_SENTRY], sentry: null }));

    expect(result.steps.map((s) => s.step)).toEqual(["vercel", "slack"]);
    expect(w.calls.filter((c) => c.startsWith("sentry"))).toEqual([]);
    expect(w.slack.map((m) => m.channel)).toEqual(["#ops-b"]);
    expect(result.heartbeat).toBe("sent");
  });

  it("사이트 하나가 실패해도 다른 사이트는 처리한다", async () => {
    w.state.deployments = [deployment("dpl_1", "ERROR")];
    w.state.fail.sentry = 503;
    const result = await runCollect(deps("01:00", { targets: [TARGET, NO_SENTRY] }));

    expect(result.steps.filter((s) => s.target === "site-b").every((s) => s.ok)).toBe(true);
    expect(w.slack.map((m) => m.channel).sort()).toEqual(["#ops-a", "#ops-b"]);
    expect(result.heartbeat).toBe("skipped");
  });

  it("heartbeat 주소가 없으면 보내지 않고, 핑이 실패하면 failed로 남긴다", async () => {
    expect((await runCollect(deps("01:00", { heartbeatUrl: null }))).heartbeat).toBe("disabled");
    w.state.fail.heartbeat = 500;
    expect((await runCollect(deps("01:05"))).heartbeat).toBe("failed");
  });

  it("실행 예산을 넘기면 남은 요청을 끊고 heartbeat를 보내지 않는다", async () => {
    const slow: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason));
      });

    const result = await runCollect(deps("01:00", { fetchImpl: slow, budgetMs: 20 }));
    expect(result.steps.filter((s) => s.step !== "slack").every((s) => !s.ok)).toBe(true);
    expect(result.steps[0].reason).toBe("network");
    expect(result.heartbeat).toBe("skipped");
    expect(await acquireLock(db, "collect", "other-run", at("01:00"))).toBe(true);
  });

  describe("실행 기록(/ops status)", () => {
    const runs = async () => {
      const { rows } = await db.execute(
        "SELECT caller, started_at, finished_at, status, steps_ok, steps_total, heartbeat FROM collect_runs ORDER BY id",
      );
      return rows.map((r) => ({
        caller: r.caller,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        status: r.status,
        stepsOk: Number(r.steps_ok),
        stepsTotal: Number(r.steps_total),
        heartbeat: r.heartbeat,
      }));
    };

    it("자동 수집은 시작·끝 시각, 결과, 성공한 단계 수, heartbeat를 남긴다", async () => {
      w.state.sentryIssues = [sentryIssue("101")];
      w.state.fail.vercel = 500;
      let tick = 0;
      await runCollect(deps("01:00", { now: () => new Date(at("01:00").getTime() + 1_000 * tick++) }));

      expect(await runs()).toEqual([
        {
          caller: "cron",
          startedAt: at("01:00").toISOString(),
          finishedAt: expect.not.stringMatching(/^2026-11-09T01:00:00\.000Z$/),
          status: "done",
          stepsOk: 3,
          stepsTotal: 4,
          heartbeat: "skipped",
        },
      ]);
    });

    it("Slack에서 부른 실행은 caller를 slack으로 남긴다", async () => {
      await runCollect(deps("01:00", { caller: "slack", heartbeatUrl: null }));
      expect(await runs()).toMatchObject([{ caller: "slack", status: "done", heartbeat: "disabled" }]);
      expect(w.calls).not.toContain("heartbeat");
    });

    it("잠금에 막힌 실행도 남긴다", async () => {
      await acquireLock(db, "collect", "other-run", at("01:00"));
      await runCollect(deps("01:01"));
      expect(await runs()).toMatchObject([{ status: "locked", stepsOk: 0, stepsTotal: 0, heartbeat: "skipped" }]);
    });

    it("중간에 실패하면 failed로 남기고 잠금을 푼다", async () => {
      // 보관 기간 정리(purgeExpired)에서 실패하게 한다
      await expect(
        runCollect(deps("01:00", { db: failingDb(db, "batch", "DELETE FROM incidents") })),
      ).rejects.toThrow("db down");

      expect(await runs()).toMatchObject([{ caller: "cron", status: "failed", stepsTotal: 4 }]);
      expect(await acquireLock(db, "collect", "other-run", at("01:00"))).toBe(true);
    });

    it("[리뷰 P2-2] 기록이 끝나지 않아도 잠금을 풀고 결과를 돌려준다", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const hanging = failingDb(db, "execute", "INSERT INTO collect_runs", "hang");
        const result = await runCollect(deps("01:00", { db: hanging, recordTimeoutMs: 20 }));
        expect(result.status).toBe("done");
        expect(await acquireLock(db, "collect", "other-run", at("01:00"))).toBe(true);
        expect(errors).toHaveBeenCalledWith("[collect] 실행 기록 실패: timeout");
      } finally {
        errors.mockRestore();
      }
    }, 2_000);

    it("기록이 실패해도 수집 결과는 그대로 돌려준다", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const result = await runCollect(deps("01:00", { db: failingDb(db, "execute", "INSERT INTO collect_runs") }));
        expect(result.status).toBe("done");
        expect(result.heartbeat).toBe("sent");
        expect(errors).toHaveBeenCalledWith("[collect] 실행 기록 실패: internal");
        expect(await runs()).toEqual([]);
      } finally {
        errors.mockRestore();
      }
    });
  });

  describe("Claude 요약", () => {
    const ANSWER = {
      summary: "칼럼 목록 조회 쿼리가 실패하고 있습니다.",
      suspectedLayer: "DB",
      deployRelated: false,
      crossSite: false,
      userImpact: "칼럼 목록이 보이지 않습니다.",
      nextChecks: ["쿼리 오류 로그 확인"],
      confidence: "중간",
    };

    /** Claude API 대신 쓰는 가짜. 받은 요청을 남긴다. */
    function claude(reply: () => unknown) {
      const requests: { system: string; messages: { content: string }[] }[] = [];
      const client = {
        messages: {
          create: async (params: (typeof requests)[number]) => {
            requests.push(params);
            return reply();
          },
        },
      } as unknown as ClaudeClient;
      return { client, requests };
    }
    const answered = () => ({
      model: "claude-opus-5-5",
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify(ANSWER) }],
    });

    beforeEach(() => {
      w.state.sentryIssues = [sentryIssue("101")];
      w.state.sentryEvents["101"] = {
        entries: [
          {
            type: "exception",
            data: {
              values: [
                {
                  type: "Error",
                  stacktrace: {
                    frames: [
                      { filename: "node_modules/x.js", function: "run", lineNo: 1, inApp: false },
                      { filename: "src/entities/article/api/queries.ts", function: "listArticles", lineNo: 67, inApp: true },
                    ],
                  },
                },
              ],
            },
          },
        ],
      };
    });

    it("키가 있으면 알림에 요약을 붙이고 최신 이벤트의 스택을 근거로 넘긴다", async () => {
      const { client, requests } = claude(answered);
      const result = await runCollect(deps("01:00", { anthropicApiKey: "test-key", claude: client }));

      expect(result.delivered).toMatchObject({ detailed: 1, analyzed: 1, analysisFailed: 0 });
      expect(requests).toHaveLength(1);
      expect(requests[0].messages[0].content).toContain("src/entities/article/api/queries.ts");
      expect(requests[0].messages[0].content).not.toContain("node_modules/x.js");
      expect(w.calls).toContain("sentry:event:101");
      expect(w.slack[0].body).toContain("칼럼 목록 조회 쿼리가 실패하고 있습니다.");
      expect(w.slack[0].body).toContain("위치 src/entities/article/api/queries.ts:67 (listArticles)");
      expect(result.heartbeat).toBe("sent");
    });

    it("하루 상한에 닿았으면 Claude를 부르지 않고 템플릿으로 보낸다", async () => {
      for (let i = 0; i < DAILY_ANALYSIS_LIMIT; i++) await reserveAnalysisCall(db, at("00:00"), DAILY_ANALYSIS_LIMIT);
      const { client, requests } = claude(answered);

      const result = await runCollect(deps("01:00", { anthropicApiKey: "test-key", claude: client }));
      expect(requests).toEqual([]);
      expect(result.delivered).toMatchObject({ detailed: 1, analyzed: 0, analysisFailed: 1 });
      expect(w.slack[0].body).toContain("요약 없음 · 하루 상한");
      expect(result.heartbeat).toBe("sent");
    });

    it("키가 틀려도 수집·알림·heartbeat는 그대로고 알림에 드러난다", async () => {
      const { client } = claude(() => {
        throw new Anthropic.AuthenticationError(401, undefined, "invalid x-api-key", new Headers());
      });

      const result = await runCollect(deps("01:00", { anthropicApiKey: "wrong-key", claude: client }));
      expect(result.steps.every(({ ok }) => ok)).toBe(true);
      expect(w.slack[0].body).toContain("요약 없음 · API 키 확인 필요");
      expect(result.heartbeat).toBe("sent");
    });

    it("자정을 넘겨 부르면 실행 시작일이 아니라 새 날짜의 하루 상한으로 센다", async () => {
      // KST 11/9 23시에 그날 칸을 다 썼다
      for (let i = 0; i < DAILY_ANALYSIS_LIMIT; i++) await reserveAnalysisCall(db, at("14:00"), DAILY_ANALYSIS_LIMIT);
      w.state.sentryIssues = [sentryIssue("101", { firstSeen: "2026-11-09T14:58:00Z", lastSeen: "2026-11-09T14:58:00Z" })];
      const { client, requests } = claude(answered);
      // 실행은 KST 23:59에 시작하고, Claude를 부를 때는 자정을 넘겼다
      let calls = 0;
      const now = () => (calls++ === 0 ? at("14:59") : at("15:01"));

      const result = await runCollect(deps("14:59", { anthropicApiKey: "test-key", claude: client, now }));
      expect(requests).toHaveLength(1);
      expect(result.delivered).toMatchObject({ detailed: 1, analyzed: 1 });
      const { rows } = await db.execute("SELECT day, calls FROM analysis_usage ORDER BY day");
      expect(rows.map((row) => [row.day, row.calls])).toEqual([
        ["2026-11-09", DAILY_ANALYSIS_LIMIT],
        ["2026-11-10", 1],
      ]);
    });

    it("키가 없으면 Claude를 부르지 않는다", async () => {
      const { client, requests } = claude(answered);
      const result = await runCollect(deps("01:00", { anthropicApiKey: null, claude: client }));
      expect(requests).toEqual([]);
      expect(result.delivered).toMatchObject({ detailed: 1, analyzed: 0, analysisFailed: 0 });
    });
  });

  describe("외부 감시(UptimeRobot)", () => {
    const UPTIME = { apiKey: "ur-test-token" };
    const WATCHED: Target = { ...TARGET, uptime: { hosts: ["site-a.example"] } };

    function uptimeMonitor(id: number, status: string, startedAt: string | null = null, path = "/api/health") {
      return {
        id,
        friendlyName: `감시 ${id}`,
        url: `https://site-a.example${path}`,
        type: "HTTP",
        status,
        currentStateDuration: 60,
        lastIncident: startedAt
          ? { id: "1", status: "Ongoing", cause: 404, reason: "404 Not Found", startedAt, duration: null }
          : null,
      };
    }

    const watchDeps = (time: string, overrides: Partial<CollectDeps> = {}) =>
      deps(time, { targets: [WATCHED], uptimeRobot: UPTIME, ...overrides });

    it("다운된 감시를 P1 incident로 만들어 Slack으로 보내고, 다른 호스트의 감시는 무시한다", async () => {
      w.state.uptimeMonitors = [
        uptimeMonitor(10, "DOWN", "2026-11-09T00:57:00.000Z"),
        uptimeMonitor(11, "UP"),
        { ...uptimeMonitor(12, "DOWN", "2026-11-09T00:50:00.000Z"), url: "https://other.example/" },
      ];
      const create = vi.fn();

      const result = await runCollect(
        watchDeps("01:00", { anthropicApiKey: "test-key", claude: { messages: { create } } as unknown as ClaudeClient }),
      );

      expect(result.steps).toContainEqual({ target: "site-a", step: "uptime", ok: true, received: 2, skipped: 0 });
      expect(result.ingested.created).toBe(1);
      expect(w.slack).toHaveLength(1);
      expect(w.slack[0].text).toContain("[P1][사이트 A] 외부 감시 다운 (404 Not Found)");
      expect(w.slack[0].body).toContain("외부 감시 다운 · 영역 전체");
      expect(w.slack[0].body).toContain("다운 시작 11/09 09:57 (KST)");
      expect(w.slack[0].body).toContain("경로 /api/health");
      expect(w.slack[0].body).toContain("UptimeRobot에서 보기");
      expect(w.slack[0].body).toContain("https://dashboard.uptimerobot.com/monitors/10");
      // 요약할 오류 문구가 없어 Claude를 부르지 않는다
      expect(create).not.toHaveBeenCalled();
      expect(result.heartbeat).toBe("sent");
    });

    it("다운이 이어지는 동안은 다시 알리지 않고, 해결 버튼으로 닫으면 같은 다운으로는 다시 열지 않는다", async () => {
      w.state.uptimeMonitors = [uptimeMonitor(10, "DOWN", "2026-11-09T00:57:00.000Z")];
      await runCollect(watchDeps("01:00"));
      await runCollect(watchDeps("01:05"));
      expect(w.slack).toHaveLength(1);

      const [incident] = await listOpenUptime();
      await db.execute({
        sql: "UPDATE incidents SET status = 'resolved', resolved_at = ? WHERE id = ?",
        args: [at("01:06").toISOString(), incident.id],
      });

      const again = await runCollect(watchDeps("01:10"));
      expect(again.ingested.reopened).toBe(0);
      expect(w.slack).toHaveLength(1);
    });

    it("새로 다운되면(시작 시각이 바뀌면) 재발로 다시 알린다", async () => {
      w.state.uptimeMonitors = [uptimeMonitor(10, "DOWN", "2026-11-09T00:57:00.000Z")];
      await runCollect(watchDeps("01:00"));

      w.state.uptimeMonitors = [uptimeMonitor(10, "UP")];
      const recovered = await runCollect(watchDeps("01:05"));
      expect(recovered.ingested.resolved).toBe(1);

      w.state.uptimeMonitors = [uptimeMonitor(10, "DOWN", "2026-11-09T01:07:00.000Z")];
      const again = await runCollect(watchDeps("01:10"));
      expect(again.ingested.reopened).toBe(1);
      expect(w.slack).toHaveLength(2);
      expect(w.slack[1].body).toContain("재발 (2회차)");
      expect(w.slack[1].body).toContain("다운 시작 11/09 10:07 (KST)");
    });

    it.each([
      ["멈춤(PAUSED)", [uptimeMonitor(10, "PAUSED")], 1],
      ["목록에서 사라짐", [], 1],
      ["준비 중(STARTED)", [uptimeMonitor(10, "STARTED")], 0],
    ])("열린 incident: %s → 해결 %i건", async (_label, after, resolved) => {
      w.state.uptimeMonitors = [uptimeMonitor(10, "DOWN", "2026-11-09T00:57:00.000Z")];
      await runCollect(watchDeps("01:00"));

      w.state.uptimeMonitors = after;
      const result = await runCollect(watchDeps("01:05"));
      expect(result.ingested.resolved).toBe(resolved);
    });

    it("목록은 실행당 한 번만 읽고 사이트마다 나눈다", async () => {
      const second: Target = { ...NO_SENTRY, uptime: { hosts: ["site-b.example"] } };
      w.state.uptimeMonitors = [
        uptimeMonitor(10, "DOWN", "2026-11-09T00:57:00.000Z"),
        { ...uptimeMonitor(20, "DOWN", "2026-11-09T00:58:00.000Z"), url: "https://site-b.example/" },
      ];

      const result = await runCollect(watchDeps("01:00", { targets: [WATCHED, second] }));

      expect(w.calls.filter((call) => call === "uptime")).toHaveLength(1);
      expect(result.ingested.created).toBe(2);
      expect(w.slack.map((m) => m.channel).sort()).toEqual(["#ops-a", "#ops-b"]);
    });

    it("UptimeRobot이 실패하면 그 단계를 실패로 남기고 다른 수집은 계속하며 heartbeat는 보내지 않는다", async () => {
      w.state.fail.uptime = 401;
      w.state.sentryIssues = [sentryIssue("101")];

      const result = await runCollect(watchDeps("01:00"));

      expect(result.steps).toContainEqual({ target: "site-a", step: "uptime", ok: false, reason: "auth" });
      expect(result.steps).toContainEqual(expect.objectContaining({ step: "sentry", ok: true }));
      expect(result.ingested.created).toBe(1);
      expect(result.heartbeat).toBe("skipped");
    });

    it("키가 없거나 감시 호스트를 정하지 않은 사이트면 단계도 요청도 없다", async () => {
      w.state.uptimeMonitors = [uptimeMonitor(10, "DOWN", "2026-11-09T00:57:00.000Z")];

      const noKey = await runCollect(watchDeps("01:00", { uptimeRobot: null }));
      const noHosts = await runCollect(deps("01:05", { uptimeRobot: UPTIME }));

      for (const result of [noKey, noHosts]) {
        expect(result.steps.map(({ step }) => step)).not.toContain("uptime");
      }
      expect(w.calls).not.toContain("uptime");
    });

    it("[리뷰 P1] 수집 사이에 회복했다가 다시 다운되면(UP을 못 봐도) 새 회차로 다시 알린다", async () => {
      w.state.uptimeMonitors = [uptimeMonitor(10, "DOWN", "2026-11-09T00:57:00.000Z")];
      await runCollect(watchDeps("01:00"));

      w.state.uptimeMonitors = [uptimeMonitor(10, "DOWN", "2026-11-09T01:03:00.000Z")];
      const again = await runCollect(watchDeps("01:05"));

      expect(again.ingested.reopened).toBe(1);
      expect(w.slack).toHaveLength(2);
      expect(w.slack[1].body).toContain("재발 (2회차)");
      expect(w.slack[1].body).toContain("다운 시작 11/09 10:03 (KST)");
    });

    it("[리뷰 P1] 옛 메시지의 해결 버튼을 새 다운이 시작된 뒤에 눌러도 새 다운을 알린다", async () => {
      w.state.uptimeMonitors = [uptimeMonitor(10, "DOWN", "2026-11-09T00:57:00.000Z")];
      await runCollect(watchDeps("01:00"));
      // 01:03에 새로 다운됐지만 아직 수집하지 못한 채, 01:04에 옛 메시지의 해결 버튼을 누른다
      const [incident] = await listOpenUptime();
      await db.execute({
        sql: "UPDATE incidents SET status = 'resolved', resolved_at = ? WHERE id = ?",
        args: [at("01:04").toISOString(), incident.id],
      });

      w.state.uptimeMonitors = [uptimeMonitor(10, "DOWN", "2026-11-09T01:03:00.000Z")];
      const again = await runCollect(watchDeps("01:05"));

      expect(again.ingested.reopened).toBe(1);
      expect(w.slack).toHaveLength(2);
    });

    it("지속 시간으로 계산한 시작 시각이 1초 흔들려도 같은 다운으로 본다", async () => {
      const byDuration = (seconds: number) => ({ ...uptimeMonitor(10, "DOWN"), currentStateDuration: seconds });
      w.state.uptimeMonitors = [byDuration(180)]; // 01:00 기준 00:57:00
      await runCollect(watchDeps("01:00"));
      const [incident] = await listOpenUptime();
      await db.execute({
        sql: "UPDATE incidents SET status = 'resolved', resolved_at = ? WHERE id = ?",
        args: [at("01:01").toISOString(), incident.id],
      });

      w.state.uptimeMonitors = [byDuration(481)]; // 01:05 기준 00:56:59
      const again = await runCollect(watchDeps("01:05"));

      expect(again.ingested.reopened).toBe(0);
      expect(w.slack).toHaveLength(1);
    });

    it("[리뷰 P2] 형식이 다른 항목이 있으면 목록에 없다는 이유로 닫지 않는다", async () => {
      w.state.uptimeMonitors = [uptimeMonitor(10, "DOWN", "2026-11-09T00:57:00.000Z")];
      await runCollect(watchDeps("01:00"));

      w.state.uptimeMonitors = [{ ...uptimeMonitor(10, "DOWN", "2026-11-09T00:57:00.000Z"), currentStateDuration: "x" }];
      const result = await runCollect(watchDeps("01:05"));

      expect(result.ingested.resolved).toBe(0);
      expect(await listOpenUptime()).toHaveLength(1);
      expect(result.steps).toContainEqual(
        expect.objectContaining({ step: "uptime", ok: false, reason: "invalid_items", skipped: 1 }),
      );
      expect(result.heartbeat).toBe("skipped");
    });

    it("[리뷰 P2] 쪽 수 상한에 닿으면 읽은 만큼 알리되 단계를 실패로 남기고, 없는 감시를 닫지 않는다", async () => {
      // 01:00: 감시 20이 다운 → incident
      w.state.uptimeMonitors = [{ ...uptimeMonitor(20, "DOWN", "2026-11-09T00:50:00.000Z"), url: "https://site-a.example/x" }];
      await runCollect(watchDeps("01:00"));

      // 01:05: 감시 20은 뒤쪽(못 읽은 쪽)에 있고, 앞쪽에서 감시 10이 새로 다운
      w.state.uptimeMonitors = [uptimeMonitor(10, "DOWN", "2026-11-09T01:02:00.000Z")];
      w.state.uptimeNextLink = "https://api.uptimerobot.com/v3/monitors?limit=50&cursor=1";
      const result = await runCollect(watchDeps("01:05"));

      expect(w.calls.filter((call) => call === "uptime")).toHaveLength(1 + 4);
      expect(result.steps).toContainEqual({ target: "site-a", step: "uptime", ok: false, reason: "incomplete" });
      expect(result.ingested.created).toBe(1);
      expect(result.ingested.resolved).toBe(0);
      expect(await listOpenUptime()).toHaveLength(2);
      expect(result.heartbeat).toBe("skipped");
    });

    async function listOpenUptime() {
      const { rows } = await db.execute("SELECT id FROM incidents WHERE fingerprint LIKE 'uptime:%' AND status = 'open'");
      return rows.map((row) => ({ id: Number(row.id) }));
    }
  });
});

describe("rotate", () => {
  it("limit보다 적으면 전부, 많으면 실행마다 limit씩 밀린 위치부터 자른다", () => {
    const items = Array.from({ length: 12 }, (_, i) => i);
    expect(rotate(items.slice(0, 3), at("01:00"), 10)).toEqual([0, 1, 2]);
    const a = rotate(items, at("01:00"), 10);
    const b = rotate(items, at("01:05"), 10);
    expect(a).toHaveLength(10);
    expect(new Set([...a, ...b]).size).toBe(12);
  });
});

describe("reasonOf", () => {
  it("밖으로 내보내는 이유는 고정된 문자열뿐이다", () => {
    expect(reasonOf(new SourceError("sentry", "auth", 401))).toBe("auth");
    expect(reasonOf(new SlackError("rate_limit", "ratelimited"))).toBe("rate_limit");
    expect(reasonOf(new Error("libsql://secret-url token=abc"))).toBe("internal");
    expect(reasonOf("문자열 오류")).toBe("internal");
  });

});
