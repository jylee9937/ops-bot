import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/lib/__fixtures__/test-db";
import { ANALYSIS_MODEL, type Analysis, type ClaudeClient } from "@/lib/analysis";
import { acquireLock, recordRun } from "@/lib/incidents";
import { ephemeral } from "@/lib/slack";

// after()는 요청 밖에서 부를 수 없다. 응답 뒤 작업을 모아 두었다가 직접 실행한다.
const deferred: Array<() => unknown> = [];
vi.mock("next/server", () => ({ after: (task: () => unknown) => deferred.push(task) }));

// eval은 실제 Claude API 대신 가짜 클라이언트를 쓴다.
const claude = vi.hoisted(() => ({ create: undefined as unknown as ReturnType<typeof vi.fn> }));
vi.mock("@/lib/analysis", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/analysis")>();
  return {
    ...original,
    claudeClient: vi.fn(() => ({ messages: { create: claude.create } }) as unknown as ClaudeClient),
  };
});

const { POST } = await import("./route");

const SECRET = "test-signing-secret";
const OWNER = "U0OWNER1";
const RESPONSE_URL = "https://hooks.slack.com/commands/T1/1/abc";
const HEARTBEAT = "https://hc-ping.example/check-1";
const TARGET = {
  id: "site-a",
  name: "사이트 A",
  vercel: { projectId: "prj_a", productionBranch: "main" },
  slackChannel: "#ops-a",
};
const VALID: Analysis = {
  summary: "공개 목록 조회가 DB 시간 초과로 실패하고 있습니다.",
  suspectedLayer: "DB",
  deployRelated: false,
  crossSite: false,
  userImpact: "목록이 비어 보입니다.",
  nextChecks: ["DB 쿼리 지연 확인"],
  confidence: "중간",
};

function command(text: string, { user = OWNER, responseUrl = RESPONSE_URL } = {}) {
  return new URLSearchParams({
    token: "deprecated-verification-token",
    team_id: "T1",
    channel_id: "C1",
    user_id: user,
    command: "/ops",
    text,
    response_url: responseUrl,
    trigger_id: "1.2.3",
  }).toString();
}

function signedRequest(body: string, { secret = SECRET, age = 0 } = {}) {
  const timestamp = String(Math.floor(Date.now() / 1000) - age);
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return new Request("http://localhost/api/slack/commands", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body,
  });
}

async function runDeferred() {
  while (deferred.length) await deferred.shift()?.();
}

describe("POST /api/slack/commands", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let requests: string[];
  let responses: Array<{ url: string; body: Record<string, unknown> }>;

  beforeEach(async () => {
    db = await createTestDb();
    deferred.length = 0;
    requests = [];
    responses = [];
    claude.create = vi.fn(async () => ({
      model: ANALYSIS_MODEL,
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify(VALID) }],
    }));
    vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
    vi.stubEnv("SLACK_OWNER_USER_ID", OWNER);
    vi.stubEnv("OPS_TARGETS", JSON.stringify([TARGET]));
    vi.stubEnv("TURSO_DATABASE_URL", db.url);
    vi.stubEnv("TURSO_AUTH_TOKEN", "");
    vi.stubEnv("VERCEL_TEAM_ID", "team_test");
    vi.stubEnv("VERCEL_TOKEN", "vercel-test-token");
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test-token");
    vi.stubEnv("HEARTBEAT_URL", HEARTBEAT);
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push(url.href === HEARTBEAT ? "heartbeat" : url.hostname);
      if (url.hostname === "hooks.slack.com") {
        responses.push({ url: url.href, body: JSON.parse(String(init?.body)) });
        return new Response("ok");
      }
      if (url.hostname === "api.vercel.com") return Response.json({ deployments: [], pagination: { next: null } });
      if (url.hostname === "slack.com") return Response.json({ ok: true, ts: "1.2" });
      return new Response("OK");
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    db.cleanup();
  });

  describe("확인", () => {
    it.each([
      ["다른 비밀로 서명했으면", { secret: "wrong-secret" }],
      ["5분 넘게 지난 요청이면", { age: 301 }],
    ])("%s 401이고 아무 일도 하지 않는다", async (_label, options) => {
      const response = await POST(signedRequest(command("collect"), options));
      expect(response.status).toBe(401);
      expect(deferred).toHaveLength(0);
      expect(requests).toEqual([]);
    });

    it("서명 비밀이나 담당자 설정이 없으면 500이다", async () => {
      vi.stubEnv("SLACK_SIGNING_SECRET", "");
      expect((await POST(signedRequest(command("status")))).status).toBe(500);
      vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
      vi.stubEnv("SLACK_OWNER_USER_ID", "");
      expect((await POST(signedRequest(command("status")))).status).toBe(500);
      expect(deferred).toHaveLength(0);
    });

    it("서명은 맞지만 형식이 다르면 400이다", async () => {
      const response = await POST(signedRequest(command("status", { responseUrl: "https://evil.example/hook" })));
      expect(response.status).toBe(400);
      expect(deferred).toHaveLength(0);
    });

    it("Slack 인증서 확인 요청은 200으로 끝낸다", async () => {
      const response = await POST(signedRequest("ssl_check=1&token=x"));
      expect(response.status).toBe(200);
      expect(deferred).toHaveLength(0);
    });

    it.each(["status", "collect", "eval"])(
      "담당자가 아니면 %s도 거절 문구만 받고 아무 일도 하지 않는다",
      async (text) => {
        const response = await POST(signedRequest(command(text, { user: "U0OTHER1" })));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(ephemeral("이 명령은 담당자만 쓸 수 있습니다."));
        expect(deferred).toHaveLength(0);
        expect(requests).toEqual([]);
      },
    );
  });

  describe("첫 답", () => {
    it("사용법과 잘못된 인자는 일을 만들지 않고 바로 답한다", async () => {
      for (const text of ["", "help", "deploy", "eval nope"]) {
        const response = await POST(signedRequest(command(text)));
        expect(response.status).toBe(200);
        expect((await response.json()).response_type).toBe("ephemeral");
      }
      expect(deferred).toHaveLength(0);
    });

    it.each([
      ["status", "확인하는 중"],
      ["collect", "수집을 시작했습니다"],
      ["eval", "eval을 시작했습니다"],
    ])("%s는 일을 끝내기 전에 '실행 중'을 바로 돌려준다(3초 제한)", async (text, ack) => {
      // 실제 일이 끝나지 않아도 응답은 기다리지 않는다
      vi.stubGlobal("fetch", () => new Promise(() => {}));
      const started = performance.now();
      const response = await POST(signedRequest(command(text)));
      const elapsed = performance.now() - started;

      expect(response.status).toBe(200);
      expect((await response.json()).text).toContain(ack);
      expect(deferred).toHaveLength(1);
      expect(elapsed).toBeLessThan(1_000);
    });
  });

  describe("응답 뒤 결과", () => {
    const resultText = () => {
      expect(responses).toHaveLength(1);
      expect(responses[0].url).toBe(RESPONSE_URL);
      expect(responses[0].body).toMatchObject({ response_type: "ephemeral", replace_original: false });
      return String(responses[0].body.text);
    };

    it("status: 마지막 수집과 사용량을 response_url로 보낸다", async () => {
      await recordRun(db.db, {
        caller: "cron",
        startedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        finishedAt: new Date().toISOString(),
        status: "done",
        stepsOk: 2,
        stepsTotal: 2,
        heartbeat: "sent",
      });
      await POST(signedRequest(command("status")));
      await runDeferred();

      const text = resultText();
      expect(text).toContain("*ops-bot 상태*");
      expect(text).toContain("(2분 전) · 완료 · 단계 2/2 성공 · heartbeat 보냄");
      expect(text).toContain("알림 요약 0/50 · eval 0/3");
    });

    it("collect: 수집하고 결과를 보내며 heartbeat는 보내지 않는다", async () => {
      await POST(signedRequest(command("collect")));
      await runDeferred();

      expect(resultText()).toContain("*수집 완료* · 단계 2/2 성공");
      expect(requests).not.toContain("heartbeat");
      const { rows } = await db.db.execute("SELECT caller, heartbeat FROM collect_runs");
      expect(rows.map((r) => [r.caller, r.heartbeat])).toEqual([["slack", "disabled"]]);
    });

    it("collect: cron이 돌고 있으면 같은 잠금에 막혀 건너뛴다", async () => {
      await acquireLock(db.db, "collect", "cron-run", new Date());
      await POST(signedRequest(command("collect")));
      await runDeferred();

      expect(resultText()).toContain("이미 다른 수집이 돌고 있어");
      expect(requests).toEqual(["hooks.slack.com"]);
    });

    it("eval: 기본 2건을 돌리고 결과를 보낸다", async () => {
      await POST(signedRequest(command("eval")));
      await runDeferred();

      const text = resultText();
      expect(text).toContain("· 오늘 1/3회");
      expect(text).toContain("`db-timeout`");
      expect(text).toContain("`injection-title`");
      expect(claude.create).toHaveBeenCalledTimes(2);
    });

    it("[리뷰 P2-1] 같은 서명의 요청이 겹쳐 오거나 끝난 뒤 다시 와도 한 번만 실행한다", async () => {
      const body = command("eval");
      const first = signedRequest(body);
      const replay = () => new Request(first.url, { method: "POST", headers: first.headers, body });

      await POST(first);
      await POST(replay());
      await Promise.all(deferred.splice(0).map((task) => task()));
      expect(claude.create).toHaveBeenCalledTimes(2);
      expect(responses).toHaveLength(1);

      await POST(replay());
      await runDeferred();
      expect(claude.create).toHaveBeenCalledTimes(2);
      expect(responses).toHaveLength(1);
      const { rows } = await db.db.execute("SELECT calls FROM command_usage");
      expect(rows.map((r) => Number(r.calls))).toEqual([1]);
    });

    it("[리뷰 P3] 결과는 자동 링크를 끈 블록으로 보낸다", async () => {
      await POST(signedRequest(command("status")));
      await runDeferred();
      const text = resultText();
      expect(responses[0].body.blocks).toEqual([{ type: "section", text: { type: "mrkdwn", text, verbatim: true } }]);
    });

    it("일이 실패하면 원문 없이 일반 문구로 알린다", async () => {
      vi.stubEnv("TURSO_DATABASE_URL", "");
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await POST(signedRequest(command("status")));
        await runDeferred();
        expect(resultText()).toBe("처리하지 못했습니다. 잠시 뒤 다시 해 보세요.");
        expect(errors).toHaveBeenCalledWith("[slack/commands] status 실패", "Error");
      } finally {
        errors.mockRestore();
      }
    });

    it("결과를 보내지 못해도 던지지 않는다", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        if (new URL(String(input)).hostname === "hooks.slack.com") return new Response("gone", { status: 404 });
        return new Response("OK");
      });
      try {
        await POST(signedRequest(command("status")));
        await expect(runDeferred()).resolves.toBeUndefined();
        expect(errors).toHaveBeenCalledWith("[slack/commands] 결과 전송 실패", "SlackError");
      } finally {
        errors.mockRestore();
      }
    });
  });
});
