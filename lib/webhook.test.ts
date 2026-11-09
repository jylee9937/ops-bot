import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "./__fixtures__/test-db";
import { runCollect } from "./collect";
import { listPending, resolveIncident } from "./incidents";
import { deployFailedSignal } from "./sources/vercel";
import type { Target } from "./targets";
import { handleDeployFailure } from "./webhook";

const at = (time: string) => new Date(`2026-11-09T${time}:00.000Z`);
const TARGET: Target = {
  id: "site-a",
  name: "사이트 A",
  vercel: { projectId: "prj_a", productionBranch: "main" },
  slackChannel: "#ops-a",
  areas: [],
};
const SLACK = { token: "xoxb-test-token", ownerUserId: "U0OWNER1" };

const failed = (time = "01:00") =>
  deployFailedSignal("site-a", {
    deploymentId: "dpl_Failed01",
    link: "https://vercel.com/team/site-a/Failed01",
    firstSeen: at(time).toISOString(),
    lastSeen: at(time).toISOString(),
  });

function slackWorld() {
  const sent: string[] = [];
  let fail: string | null = null;
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.vercel.com") {
      return Response.json({
        deployments: [
          {
            uid: "dpl_Failed01",
            created: at("00:55").getTime(),
            ready: at("01:00").getTime(),
            readyState: "ERROR",
            target: "production",
            errorCode: "BUILD_FAILED",
            inspectorUrl: "https://vercel.com/team/site-a/Failed01",
          },
        ],
        pagination: { next: null },
      });
    }
    if (url.hostname !== "slack.com") throw new Error(`예상하지 못한 요청: ${url.hostname}`);
    if (fail) return Response.json({ ok: false, error: fail });
    sent.push(JSON.parse(String(init?.body)).text);
    return Response.json({ ok: true, ts: `1700000000.${String(sent.length).padStart(6, "0")}` });
  };
  return { sent, impl, failWith: (code: string | null) => (fail = code) };
}

describe("handleDeployFailure", () => {
  let db: Client;
  let cleanup: () => void;
  let slack: ReturnType<typeof slackWorld>;

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    slack = slackWorld();
  });
  afterEach(() => cleanup());

  const handle = (time: string, signal = failed()) =>
    handleDeployFailure(TARGET, signal, {
      db,
      slack: SLACK,
      fetchImpl: slack.impl,
      sleep: async () => {},
      now: () => at(time),
    });

  it("배포 실패를 incident로 만들고 바로 Slack으로 보낸다", async () => {
    const result = await handle("01:00");
    expect(result.ingested.created).toBe(1);
    expect(result.delivered.detailed).toBe(1);
    expect(result.deliveryError).toBeNull();
    expect(slack.sent).toEqual([`<@${SLACK.ownerUserId}> [P1][사이트 A] 배포 실패`]);
  });

  it("같은 이벤트가 다시 와도(재시도·재전송) 알림은 한 번이다", async () => {
    await handle("01:00");
    await handle("01:01");
    expect(slack.sent).toHaveLength(1);
  });

  it("해결한 뒤 옛 이벤트가 다시 와도 다시 열지 않는다", async () => {
    await handle("01:00");
    await resolveIncident(db, "site-a", "vercel:dpl_Failed01:ERROR", at("01:10"));
    const replay = await handle("02:00");

    expect(replay.ingested).toMatchObject({ created: 0, reopened: 0 });
    expect(slack.sent).toHaveLength(1);
    const { rows } = await db.execute("SELECT status FROM incidents");
    expect(rows[0].status).toBe("resolved");
  });

  it("webhook 뒤 폴링이 같은 실패를 읽어도 알림은 한 번이다", async () => {
    await handle("01:00");
    const collected = await runCollect({
      db,
      targets: [TARGET],
      sentry: null,
      vercel: { teamId: "team_test", token: "vercel-test-token" },
      slack: SLACK,
      heartbeatUrl: null,
      fetchImpl: slack.impl,
      sleep: async () => {},
      now: () => at("01:05"),
    });
    expect(collected.ingested.created).toBe(0);
    expect(slack.sent).toHaveLength(1);
  });

  it("Slack이 실패해도 incident는 남아 다음 collect가 보낸다", async () => {
    slack.failWith("invalid_auth");
    const result = await handle("01:00");
    expect(result.ingested.created).toBe(1);
    expect(result.deliveryError).toBeInstanceOf(Error);
    expect(await listPending(db, "site-a", at("01:01"))).toHaveLength(1);
  });

  it("빈 DB에서도 스키마를 만들고 처리한다", async () => {
    const fresh = await createTestDb({ migrated: false });
    try {
      const result = await handleDeployFailure(TARGET, failed(), {
        db: fresh.db,
        slack: SLACK,
        fetchImpl: slack.impl,
        sleep: async () => {},
        now: () => at("01:00"),
      });
      expect(result.ingested.created).toBe(1);
    } finally {
      fresh.cleanup();
    }
  });
});
