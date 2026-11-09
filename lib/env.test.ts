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
    });
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
});
