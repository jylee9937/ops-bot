import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/lib/__fixtures__/test-db";
import { getIncident, ingest } from "@/lib/incidents";
import { maskLogMessage, tagOf } from "@/lib/mask";
import { ephemeral } from "@/lib/slack";
import type { Target } from "@/lib/targets";

// after()는 요청 밖에서 부를 수 없다. 응답 뒤 작업을 모아 두었다가 직접 실행한다.
const deferred: Array<() => unknown> = [];
vi.mock("next/server", () => ({ after: (task: () => unknown) => deferred.push(task) }));

const { POST } = await import("./route");

const SECRET = "test-signing-secret";
const OWNER = "U0OWNER1";
const RESPONSE_URL = "https://hooks.slack.com/actions/T1/1/abc";
const TARGET: Target = {
  id: "site-a",
  name: "사이트 A",
  vercel: { projectId: "prj_a", productionBranch: "main" },
  slackChannel: "#ops-a",
  areas: [{ name: "공개 조회", severity: "P2", match: ["articles"] }],
};

function payload(user = OWNER, value = "1:1", actionId = "resolve") {
  return new URLSearchParams({
    payload: JSON.stringify({
      type: "block_actions",
      user: { id: user },
      response_url: RESPONSE_URL,
      actions: [{ action_id: actionId, value }],
    }),
  }).toString();
}

function signedRequest(body: string, { secret = SECRET, age = 0 } = {}) {
  const timestamp = String(Math.floor(Date.now() / 1000) - age);
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return new Request("http://localhost/api/slack/actions", {
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

describe("POST /api/slack/actions", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let responses: Array<{ url: string; body: Record<string, unknown> }>;

  beforeEach(async () => {
    db = await createTestDb();
    deferred.length = 0;
    responses = [];
    vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
    vi.stubEnv("SLACK_OWNER_USER_ID", OWNER);
    vi.stubEnv("OPS_TARGETS", JSON.stringify([TARGET]));
    vi.stubEnv("TURSO_DATABASE_URL", db.url);
    vi.stubEnv("TURSO_AUTH_TOKEN", "");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      responses.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response("ok");
    });

    const title = maskLogMessage("[articles] 목록 조회 실패");
    await ingest(
      db.db,
      TARGET,
      [
        {
          target: "site-a",
          source: "sentry",
          kind: "issue.new",
          fingerprint: "sentry:1",
          sourceId: "1",
          title,
          tag: tagOf(title),
          route: null,
          count: 1,
          users: 0,
          firstSeen: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
          link: "https://sentry.io/issues/1/",
        },
      ],
      new Date(),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    db.cleanup();
  });

  it("담당자가 누르면 바로 200을 주고, 응답 뒤에 해결하고 메시지를 바꾼다", async () => {
    const response = await POST(signedRequest(payload()));
    expect(response.status).toBe(200);
    // 응답 전에는 상태를 바꾸지 않는다
    expect((await getIncident(db.db, 1))?.status).toBe("open");

    await runDeferred();
    expect((await getIncident(db.db, 1))?.status).toBe("resolved");
    expect(responses).toHaveLength(1);
    expect(responses[0].url).toBe(RESPONSE_URL);
    expect(responses[0].body).toMatchObject({ replace_original: true });
  });

  it("서명이 틀리면 401이고 아무것도 하지 않는다", async () => {
    const response = await POST(signedRequest(payload(), { secret: "wrong-secret" }));
    expect(response.status).toBe(401);
    expect(deferred).toHaveLength(0);
  });

  it("5분 넘게 지난 요청은 401이다", async () => {
    const response = await POST(signedRequest(payload(), { age: 301 }));
    expect(response.status).toBe(401);
    expect(deferred).toHaveLength(0);
  });

  it("서명 뒤 본문을 바꾸면 401이다", async () => {
    const original = signedRequest(payload());
    const tampered = new Request(original.url, {
      method: "POST",
      headers: original.headers,
      body: payload(OWNER, "1:1", "mute_30d"),
    });
    expect((await POST(tampered)).status).toBe(401);
  });

  it("담당자가 아니면 상태를 바꾸지 않고 누른 사람에게만 알린다", async () => {
    const response = await POST(signedRequest(payload("U0STRANGER")));
    expect(response.status).toBe(200);

    await runDeferred();
    expect((await getIncident(db.db, 1))?.status).toBe("open");
    expect(responses).toEqual([{ url: RESPONSE_URL, body: ephemeral("이 버튼은 담당자만 누를 수 있습니다.") }]);
  });

  it("링크 버튼은 200만 돌려준다", async () => {
    const response = await POST(signedRequest(payload(OWNER, "", "open_link")));
    expect(response.status).toBe(200);
    expect(deferred).toHaveLength(0);
  });

  it("64KB가 넘는 본문은 서명을 계산하기 전에 413이다", async () => {
    const big = `${payload()}&pad=${"a".repeat(64 * 1024)}`;
    expect((await POST(signedRequest(big))).status).toBe(413);
  });

  it("형식이 다른 본문은 400이다", async () => {
    expect((await POST(signedRequest("payload=%7Bbroken"))).status).toBe(400);
  });

  it("설정이 비어 있으면 500이고 서명을 확인하지 않는다", async () => {
    vi.stubEnv("SLACK_OWNER_USER_ID", "");
    expect((await POST(signedRequest(payload()))).status).toBe(500);
    vi.stubEnv("SLACK_OWNER_USER_ID", OWNER);
    vi.stubEnv("SLACK_SIGNING_SECRET", "");
    expect((await POST(signedRequest(payload()))).status).toBe(500);
  });

  it("처리 중 오류가 나면 누른 사람에게만 실패를 알린다", async () => {
    vi.stubEnv("OPS_TARGETS", "not json");
    expect((await POST(signedRequest(payload()))).status).toBe(200);

    await runDeferred();
    expect((await getIncident(db.db, 1))?.status).toBe("open");
    expect(responses.map((r) => r.body.text)).toEqual(["처리하지 못했습니다. 잠시 뒤 다시 눌러 주세요."]);
  });
});
