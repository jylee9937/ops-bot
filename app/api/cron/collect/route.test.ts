import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/lib/__fixtures__/test-db";
import { GET } from "./route";

const SECRET = "test-cron-secret-0123456789";
const TARGETS = [
  {
    id: "site-a",
    name: "사이트 A",
    vercel: { projectId: "prj_a", productionBranch: "main" },
    sentry: { project: "site-a-prod", environment: "production" },
    slackChannel: "#ops-a",
  },
];

const call = (authorization?: string) =>
  GET(
    new Request("http://localhost/api/cron/collect", {
      headers: authorization ? { authorization } : {},
    }),
  );

describe("GET /api/cron/collect", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let requests: string[];

  beforeEach(async () => {
    db = await createTestDb();
    requests = [];
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("TURSO_DATABASE_URL", db.url);
    vi.stubEnv("TURSO_AUTH_TOKEN", "");
    vi.stubEnv("OPS_TARGETS", JSON.stringify(TARGETS));
    vi.stubEnv("SENTRY_ORG", "example-org");
    vi.stubEnv("SENTRY_TOKEN", "sentry-secret-value");
    vi.stubEnv("VERCEL_TEAM_ID", "team_test");
    vi.stubEnv("VERCEL_TOKEN", "vercel-secret-value");
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-slack-secret-value");
    vi.stubEnv("SLACK_OWNER_USER_ID", "U0OWNER1");
    vi.stubEnv("HEARTBEAT_URL", "");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requests.push(url.hostname);
      if (url.hostname === "sentry.io") {
        return Response.json([
          {
            id: "101",
            title: "Error: [articles] 비밀 제목 조회 실패",
            count: "1",
            firstSeen: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            permalink: "https://sentry.io/issues/101/",
            status: "unresolved",
            substatus: "new",
            metadata: { type: "Error", value: "[articles] 비밀 제목 조회 실패" },
          },
        ]);
      }
      if (url.hostname === "api.vercel.com") return Response.json({ deployments: [], pagination: { next: null } });
      if (url.hostname === "slack.com") return Response.json({ ok: true, ts: "1.2" });
      throw new Error(`예상하지 못한 요청: ${url.hostname}`);
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    db.cleanup();
  });

  it("CRON_SECRET이 맞으면 수집을 실행하고 건수만 돌려준다", async () => {
    const response = await call(`Bearer ${SECRET}`);
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body).toMatchObject({
      status: "done",
      ingested: { created: 1 },
      delivered: { detailed: 1 },
      heartbeat: "disabled",
    });
    expect(JSON.stringify(body)).not.toContain("비밀 제목");
    expect(requests.sort()).toEqual(["api.vercel.com", "sentry.io", "sentry.io", "slack.com"]);
  });

  // Headers는 값 앞뒤 공백을 지우므로(Fetch 표준) 공백 대신 글자를 더한 값으로 확인한다
  it.each([undefined, "Bearer wrong-secret", SECRET, `Bearer ${SECRET}x`, `bearer ${SECRET}`])(
    "인증 헤더가 %j이면 401이고 아무것도 부르지 않는다",
    async (header) => {
      expect((await call(header)).status).toBe(401);
      expect(requests).toEqual([]);
    },
  );

  it("CRON_SECRET이 없거나 너무 짧으면 500이다", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await call("Bearer ")).status).toBe(500);
    vi.stubEnv("CRON_SECRET", "short");
    expect((await call("Bearer short")).status).toBe(500);
  });

  it("설정이 틀리면 변수 이름만 돌려주고 값은 내보내지 않는다", async () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxp-leaked-user-token");
    vi.stubEnv("VERCEL_TEAM_ID", "");
    const response = await call(`Bearer ${SECRET}`);

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "config", keys: ["SLACK_BOT_TOKEN", "VERCEL_TEAM_ID"] });
    expect(text).not.toContain("xoxp-leaked-user-token");
    expect(requests).toEqual([]);
  });
});
