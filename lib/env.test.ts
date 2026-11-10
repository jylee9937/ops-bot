import { describe, expect, it } from "vitest";
import { EnvError, loadCollectEnv } from "./env";

const TARGETS = [
  {
    id: "site-a",
    name: "사이트 A",
    vercel: { projectId: "prj_a", productionBranch: "main" },
    sentry: { project: "site-a-prod", environment: "production" },
    slackChannel: "#ops-a",
  },
];
const NO_SENTRY = [{ ...TARGETS[0], sentry: undefined }];

const SECRET_VALUES = {
  SENTRY_TOKEN: "sentry-secret-value",
  VERCEL_TOKEN: "vercel-secret-value",
  SLACK_BOT_TOKEN: "xoxb-slack-secret-value",
  ANTHROPIC_API_KEY: "anthropic-secret-value",
};

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    TURSO_DATABASE_URL: "file:./test.db",
    OPS_TARGETS: JSON.stringify(TARGETS),
    SENTRY_ORG: "example-org",
    VERCEL_TEAM_ID: "team_abc123",
    SLACK_OWNER_USER_ID: "U0OWNER1",
    HEARTBEAT_URL: "https://hc-ping.example/abc",
    ...SECRET_VALUES,
    ...overrides,
  };
}

function keysOf(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    if (error instanceof EnvError) return error.keys;
    throw error;
  }
  throw new Error("오류가 나지 않았습니다");
}

describe("loadCollectEnv", () => {
  it("collect에 필요한 설정을 묶어 돌려준다", () => {
    expect(loadCollectEnv(env())).toEqual({
      targets: [expect.objectContaining({ id: "site-a" })],
      sentry: { org: "example-org", token: "sentry-secret-value" },
      vercel: { teamId: "team_abc123", token: "vercel-secret-value" },
      slack: { token: "xoxb-slack-secret-value", ownerUserId: "U0OWNER1" },
      heartbeatUrl: "https://hc-ping.example/abc",
      anthropicApiKey: "anthropic-secret-value",
      uptimeRobot: null,
    });
  });

  it("UptimeRobot 키는 선택이다. 있으면 묶고, 형식이 다르면 이름만 알린다", () => {
    expect(loadCollectEnv(env({ UPTIMEROBOT_API_KEY: "ur1234567-abcdef0123456789abcdef" })).uptimeRobot).toEqual({
      apiKey: "ur1234567-abcdef0123456789abcdef",
    });
    expect(loadCollectEnv(env({ UPTIMEROBOT_API_KEY: "" })).uptimeRobot).toBeNull();
    expect(keysOf(() => loadCollectEnv(env({ UPTIMEROBOT_API_KEY: "bad key with spaces" })))).toEqual([
      "UPTIMEROBOT_API_KEY",
    ]);
  });

  it("Claude 키는 선택이다. 없으면 null이고 다른 설정은 그대로 쓴다", () => {
    expect(loadCollectEnv(env({ ANTHROPIC_API_KEY: undefined })).anthropicApiKey).toBeNull();
    expect(loadCollectEnv(env({ ANTHROPIC_API_KEY: "" })).anthropicApiKey).toBeNull();
  });

  it("heartbeat 주소가 없으면 null이다(Preview)", () => {
    expect(loadCollectEnv(env({ HEARTBEAT_URL: undefined })).heartbeatUrl).toBeNull();
    expect(loadCollectEnv(env({ HEARTBEAT_URL: "" })).heartbeatUrl).toBeNull();
  });

  it("Sentry를 쓰는 사이트가 없으면 Sentry 설정 없이도 된다", () => {
    const config = loadCollectEnv(
      env({ OPS_TARGETS: JSON.stringify(NO_SENTRY), SENTRY_ORG: undefined, SENTRY_TOKEN: undefined }),
    );
    expect(config.sentry).toBeNull();
  });

  it("Sentry를 쓰는 사이트가 있으면 Sentry 설정이 필요하다", () => {
    expect(keysOf(() => loadCollectEnv(env({ SENTRY_ORG: undefined, SENTRY_TOKEN: "" })))).toEqual([
      "SENTRY_ORG",
      "SENTRY_TOKEN",
    ]);
  });

  it("틀린 변수의 이름을 모두 모아 알려 준다", () => {
    expect(
      keysOf(() =>
        loadCollectEnv(
          env({
            VERCEL_TEAM_ID: "prj_wrong",
            SLACK_BOT_TOKEN: "xoxp-user-token",
            SLACK_OWNER_USER_ID: "<!channel>",
            HEARTBEAT_URL: "http://insecure.example",
            OPS_TARGETS: "not json",
            TURSO_DATABASE_URL: undefined,
          }),
        ),
      ),
    ).toEqual([
      "HEARTBEAT_URL",
      "OPS_TARGETS",
      "SLACK_BOT_TOKEN",
      "SLACK_OWNER_USER_ID",
      "TURSO_DATABASE_URL",
      "VERCEL_TEAM_ID",
    ]);
  });

  it("오류 메시지에 값을 넣지 않는다", () => {
    try {
      loadCollectEnv(env({ SLACK_BOT_TOKEN: "xoxp-leaked-user-token", VERCEL_TEAM_ID: "team_" }));
      throw new Error("오류가 나지 않았습니다");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvError);
      const message = String((error as Error).message);
      expect(message).not.toContain("xoxp-leaked-user-token");
      expect(message).not.toContain("vercel-secret-value");
      expect(message).toBe("환경변수를 확인하세요: SLACK_BOT_TOKEN, VERCEL_TEAM_ID");
    }
  });

  it("[리뷰 P3-6] 원격 DB면 Turso 토큰이 필요하고, 로컬 파일이면 없어도 된다", () => {
    expect(keysOf(() => loadCollectEnv(env({ TURSO_DATABASE_URL: "libsql://db-example.turso.io" })))).toEqual([
      "TURSO_AUTH_TOKEN",
    ]);
    expect(() =>
      loadCollectEnv(env({ TURSO_DATABASE_URL: "libsql://db-example.turso.io", TURSO_AUTH_TOKEN: "turso-token" })),
    ).not.toThrow();
    expect(() => loadCollectEnv(env({ TURSO_DATABASE_URL: "file:./local.db" }))).not.toThrow();
  });

  it("[리뷰 P3-6] Sentry org slug에 밑줄을 허용한다", () => {
    expect(loadCollectEnv(env({ SENTRY_ORG: "example_org" })).sentry?.org).toBe("example_org");
  });
});
