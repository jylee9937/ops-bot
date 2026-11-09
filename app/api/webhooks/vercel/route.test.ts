import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/lib/__fixtures__/test-db";
import sample from "@/lib/sources/__fixtures__/vercel-webhook-deployment-error.json";
import { POST } from "./route";

const SECRET = "webhook-test-secret";
const TARGETS = [
  {
    id: "site-a",
    name: "사이트 A",
    vercel: { projectId: "prj_a", productionBranch: "main" },
    slackChannel: "#ops-a",
  },
];

const fresh = () => ({ ...sample, createdAt: Date.now() - 5_000 });
const sign = (body: string, secret = SECRET) => createHmac("sha1", secret).update(body).digest("hex");
const call = (body: string, signature: string | null = sign(body)) =>
  POST(
    new Request("http://localhost/api/webhooks/vercel", {
      method: "POST",
      headers: signature ? { "x-vercel-signature": signature } : {},
      body,
    }),
  );

describe("POST /api/webhooks/vercel", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let slack: string[];

  beforeEach(async () => {
    db = await createTestDb();
    slack = [];
    vi.stubEnv("VERCEL_WEBHOOK_SECRET", SECRET);
    vi.stubEnv("TURSO_DATABASE_URL", db.url);
    vi.stubEnv("TURSO_AUTH_TOKEN", "");
    vi.stubEnv("OPS_TARGETS", JSON.stringify(TARGETS));
    vi.stubEnv("VERCEL_TEAM_ID", "team_test");
    vi.stubEnv("VERCEL_TOKEN", "vercel-secret-value");
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-slack-secret-value");
    vi.stubEnv("SLACK_OWNER_USER_ID", "U0OWNER1");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname !== "slack.com") throw new Error(`예상하지 못한 요청: ${url.hostname}`);
      slack.push(JSON.parse(String(init?.body)).text);
      return Response.json({ ok: true, ts: "1.2" });
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    db.cleanup();
  });

  it("서명이 맞는 운영 배포 실패를 처리하고 바로 알린다", async () => {
    const response = await call(JSON.stringify(fresh()));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "processed",
      target: "site-a",
      ingested: { created: 1 },
      delivered: { detailed: 1 },
      delivery: "ok",
    });
    expect(slack).toEqual(["<@U0OWNER1> [P1][사이트 A] 배포 실패"]);
  });

  it("서명이 없거나 틀리면 401이고 아무것도 하지 않는다", async () => {
    const body = JSON.stringify(fresh());
    expect((await call(body, null)).status).toBe(401);
    expect((await call(body, sign(body, "wrong-secret"))).status).toBe(401);
    expect((await call(`${body} `, sign(body))).status).toBe(401);
    expect(slack).toEqual([]);
  });

  it("다른 이벤트는 200으로 무시한다(Vercel이 다시 보내지 않게)", async () => {
    const response = await call(JSON.stringify({ ...fresh(), type: "deployment.succeeded" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ignored", reason: "event" });
    expect(slack).toEqual([]);
  });

  it("형식이 다르면 400이다", async () => {
    const response = await call(JSON.stringify({ ...fresh(), payload: { deployment: {} } }));
    expect(response.status).toBe(400);
  });

  it("비밀이 설정되지 않았으면 500이다", async () => {
    vi.stubEnv("VERCEL_WEBHOOK_SECRET", "");
    expect((await call(JSON.stringify(fresh()))).status).toBe(500);
  });

  it("너무 큰 본문은 서명을 계산하기 전에 413이다", async () => {
    const body = JSON.stringify({ ...fresh(), padding: "a".repeat(256 * 1024) });
    expect((await call(body)).status).toBe(413);
  });

  it("설정이 틀리면 변수 이름만 돌려준다", async () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxp-leaked-user-token");
    const response = await call(JSON.stringify(fresh()));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "config", keys: ["SLACK_BOT_TOKEN"] });
    expect(text).not.toContain("xoxp-leaked-user-token");
  });

  it("DB를 열 수 없으면 500을 돌려 Vercel이 다시 보내게 한다", async () => {
    vi.stubEnv("TURSO_DATABASE_URL", "::not-a-db-url::");
    vi.stubEnv("TURSO_AUTH_TOKEN", "turso-token");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await call(JSON.stringify(fresh()));
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "internal" });
    } finally {
      spy.mockRestore();
    }
  });
});
