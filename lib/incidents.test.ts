import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, migrate } from "./db";
import {
  acquireLock,
  claimNotification,
  claimSlackRequest,
  claimPending,
  completeNotification,
  completeNotifications,
  getClaimedIncident,
  findCorrelatedTargets,
  getCursor,
  getIncident,
  ingest,
  isDeliveryOverdue,
  listOpenSentryIncidents,
  listClaimed,
  listPending,
  muteIncident,
  purgeExpired,
  readOpsStatus,
  recordDeploys,
  recordRun,
  releaseClaim,
  releaseLock,
  releaseNotification,
  reserveAnalysisCall,
  reserveCommandCall,
  resolveIncident,
  saveAnalysis,
  saveCursor,
  type CollectRun,
  type Incident,
  type StoredAnalysis,
} from "./incidents";
import { maskFrame, maskLogMessage, tagOf } from "./mask";
import type { Deploy, Signal } from "./signal";
import type { Target } from "./targets";

const at = (time: string) => new Date(`2026-11-07T${time}:00.000Z`);
const iso = (time: string) => at(time).toISOString();

const TARGET: Target = {
  id: "site-a",
  name: "사이트 A",
  vercel: { projectId: "prj_a", productionBranch: "main" },
  slackChannel: "#ops-a",
  areas: [
    { name: "인증", severity: "P1", match: ["auth"] },
    { name: "공개 조회", severity: "P2", match: ["articles"] },
    { name: "어드민", severity: "P3", match: ["admin"] },
  ],
};
const OTHER: Target = { ...TARGET, id: "site-b", name: "사이트 B", slackChannel: "#ops-b" };

function issue(overrides: Partial<Signal> = {}): Signal {
  const title = maskLogMessage("[articles] 공개 목록 조회 실패");
  return {
    target: "site-a",
    source: "sentry",
    kind: "issue.ongoing",
    fingerprint: "sentry:1",
    sourceId: "1",
    title,
    tag: tagOf(title),
    route: null,
    count: 1,
    users: 0,
    firstSeen: iso("00:59"),
    lastSeen: iso("00:59"),
    link: "https://sentry.io/issues/1/",
    ...overrides,
  };
}

function deployFailed(overrides: Partial<Signal> = {}): Signal {
  return issue({
    source: "vercel",
    kind: "deploy.failed",
    fingerprint: "vercel:dpl_1:ERROR",
    sourceId: "dpl_1",
    title: maskLogMessage("배포 실패 (BUILD_FAILED)"),
    tag: null,
    ...overrides,
  });
}

function deploy(overrides: Partial<Deploy> = {}): Deploy {
  return {
    target: "site-a",
    deploymentId: "dpl_1",
    sha: "abcdef0",
    state: "READY",
    createdAt: iso("00:40"),
    readyAt: null,
    ...overrides,
  };
}

/** 다음 batch 직전에 다른 작업을 끼워 넣는다. 읽은 뒤 쓰기 전에 다른 실행이 쓴 상황을 만든다. */
function interleave(db: Client, before: () => Promise<unknown>, times = 1): Client {
  let left = times;
  return new Proxy(db, {
    get(target, property) {
      if (property === "batch") {
        return async (...args: Parameters<Client["batch"]>) => {
          if (left > 0) {
            left--;
            await before();
          }
          return target.batch(...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("incidents", () => {
  let dir: string;
  let db: Client;

  const row = async (fingerprint = "sentry:1"): Promise<Incident> => {
    const { rows } = await db.execute({
      sql: "SELECT id FROM incidents WHERE fingerprint = ?",
      args: [fingerprint],
    });
    const incident = await getIncident(db, Number(rows[0].id));
    if (!incident) throw new Error("incident가 없습니다");
    return incident;
  };

  const pendingIds = async (now: Date, target = TARGET) =>
    (await listPending(db, target.id, now)).map((incident) => incident.fingerprint);

  const deliver = async (now: Date, fingerprint = "sentry:1", slackTs: string | null = "111.222") => {
    const { id } = await row(fingerprint);
    const claim = await claimNotification(db, id, now);
    if (!claim) throw new Error("전송을 시작할 수 없습니다");
    return completeNotification(db, id, claim, slackTs, now);
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ops-bot-incidents-"));
    db = createDb(`file:${join(dir, "test.db")}`, "");
    await migrate(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("ingest", () => {
    it("새 신호로 incident를 만들고 마스킹된 글자만 저장한다", async () => {
      const summary = await ingest(db, TARGET, [issue()], at("01:00"));

      expect(summary).toMatchObject({ created: 1, updated: 0 });
      expect(await row()).toMatchObject({
        target: "site-a",
        status: "open",
        episode: 1,
        severity: "P2",
        area: "공개 조회",
        title: "[articles] 공개 목록 조회 실패",
        firstSeen: iso("00:59"),
        lastSeen: iso("00:59"),
        notifiedAt: null,
        pendingSince: iso("01:00"),
        evidence: { source: "sentry", sourceId: "1", count: 1, link: "https://sentry.io/issues/1/" },
      });
      expect(await pendingIds(at("01:00"))).toEqual(["sentry:1"]);
    });

    it("빈 신호 목록은 아무것도 하지 않는다", async () => {
      expect(await ingest(db, TARGET, [], at("01:00"))).toMatchObject({ created: 0, ignored: 0 });
    });

    it("같은 신호를 다시 받아도 행 하나이고 다시 알리지 않는다", async () => {
      await ingest(db, TARGET, [issue()], at("01:00"));
      await deliver(at("01:00"));
      await ingest(db, TARGET, [issue()], at("01:00"));
      await ingest(db, TARGET, [issue()], at("01:02"));

      const { rows } = await db.execute("SELECT COUNT(*) AS total FROM incidents");
      expect(Number(rows[0].total)).toBe(1);
      expect(await pendingIds(at("01:02"))).toEqual([]);
    });

    it("한 번에 같은 지문이 여러 개 오면 가장 최근 것을 쓴다", async () => {
      await ingest(
        db,
        TARGET,
        [issue({ lastSeen: iso("00:59"), count: 1 }), issue({ lastSeen: iso("00:58"), count: 1 })],
        at("01:00"),
      );
      expect((await row()).lastSeen).toBe(iso("00:59"));
    });

    it("마지막 발생 시각은 늘리고 첫 발생 시각은 앞당긴다", async () => {
      await ingest(db, TARGET, [issue({ lastSeen: iso("00:59") })], at("01:00"));
      await ingest(db, TARGET, [issue({ firstSeen: iso("00:30"), lastSeen: iso("01:04") })], at("01:05"));
      expect(await row()).toMatchObject({ firstSeen: iso("00:30"), lastSeen: iso("01:04") });
    });

    it("두 사이트의 같은 지문을 따로 관리한다", async () => {
      await ingest(db, TARGET, [issue()], at("01:00"));
      await ingest(db, OTHER, [issue({ target: "site-b" })], at("01:00"));
      const { rows } = await db.execute("SELECT target FROM incidents ORDER BY target");
      expect(rows.map((item) => item.target)).toEqual(["site-a", "site-b"]);
    });
  });

  describe("등급 상승", () => {
    it("10분 안에 3회가 되면 오르고 다시 알린다", async () => {
      await ingest(db, TARGET, [issue({ count: 1 })], at("01:00"));
      await deliver(at("01:00"));

      const second = await ingest(db, TARGET, [issue({ count: 2 })], at("01:05"));
      expect(second.escalated).toBe(0);
      expect(await pendingIds(at("01:05"))).toEqual([]);

      const third = await ingest(db, TARGET, [issue({ count: 4 })], at("01:10"));
      expect(third.escalated).toBe(1);
      expect(await row()).toMatchObject({
        severity: "P1",
        notifiedAt: null,
        slackTs: "111.222",
        pendingSince: iso("01:10"),
      });
      expect(await pendingIds(at("01:10"))).toEqual(["sentry:1"]);
    });

    it("같은 구간을 다시 읽어도 두 번 더하지 않는다", async () => {
      await ingest(db, TARGET, [issue({ count: 2 })], at("01:00"));
      for (const time of ["01:01", "01:02", "01:03", "01:04"]) {
        await ingest(db, TARGET, [issue({ count: 2 })], at(time));
      }
      expect((await row()).severity).toBe("P2");
    });

    it("느리게 늘면 오르지 않는다", async () => {
      await ingest(db, TARGET, [issue({ count: 1 })], at("01:00"));
      await ingest(db, TARGET, [issue({ count: 2 })], at("01:15"));
      await ingest(db, TARGET, [issue({ count: 3 })], at("01:30"));
      await ingest(db, TARGET, [issue({ count: 4 })], at("01:45"));
      expect((await row()).severity).toBe("P2");
    });

    it("새 issue가 처음부터 3회 이상이면 올린 등급으로 시작한다", async () => {
      await ingest(db, TARGET, [issue({ count: 5 })], at("01:00"));
      expect((await row()).severity).toBe("P1");
    });

    it("처음 본 오래된 issue의 누적값은 증가분이 아니다", async () => {
      await ingest(db, TARGET, [issue({ count: 500, firstSeen: "2026-10-01T00:00:00.000Z" })], at("01:00"));
      expect((await row()).severity).toBe("P2");
    });

    it("영향 사용자가 기준을 넘으면 오른다", async () => {
      await ingest(db, TARGET, [issue({ users: 10 })], at("01:00"));
      expect((await row()).severity).toBe("P1");
    });

    it("조용해져도 같은 회차에서는 내려가지 않는다", async () => {
      await ingest(db, TARGET, [issue({ count: 5 })], at("01:00"));
      await deliver(at("01:00"));
      await ingest(db, TARGET, [issue({ count: 5, lastSeen: iso("00:59") })], at("02:00"));
      expect((await row()).severity).toBe("P1");
      expect(await pendingIds(at("02:00"))).toEqual([]);
    });
  });

  describe("해결과 재개방", () => {
    beforeEach(async () => {
      await ingest(db, TARGET, [issue({ count: 5 })], at("01:00"));
      await deliver(at("01:00"));
      expect(await resolveIncident(db, "site-a", "sentry:1", at("01:10"))).toBe(true);
    });

    it("해결 전 발생을 겹쳐 읽어도 다시 열지 않는다", async () => {
      const summary = await ingest(db, TARGET, [issue({ count: 5, lastSeen: iso("01:08") })], at("01:15"));
      expect(summary.ignored).toBe(1);
      expect((await row()).status).toBe("resolved");
    });

    it("해결 뒤 새 발생은 회차를 올려 다시 알린다", async () => {
      const summary = await ingest(db, TARGET, [issue({ count: 6, lastSeen: iso("01:12") })], at("01:15"));
      expect(summary.reopened).toBe(1);
      expect(await row()).toMatchObject({
        status: "open",
        episode: 2,
        severity: "P2",
        lastSeen: iso("01:12"),
        notifiedAt: null,
        slackTs: null,
        resolvedAt: null,
        pendingSince: iso("01:15"),
      });
      expect(await pendingIds(at("01:15"))).toEqual(["sentry:1"]);
    });

    it("재개방 때 많이 늘었으면 등급을 올린다", async () => {
      await ingest(db, TARGET, [issue({ count: 9, lastSeen: iso("01:12") })], at("01:15"));
      expect((await row()).severity).toBe("P1");
    });

    it("이미 해결한 incident를 다시 해결해도 바뀌지 않는다", async () => {
      expect(await resolveIncident(db, "site-a", "sentry:1", at("01:20"))).toBe(false);
      expect((await row()).resolvedAt).toBe(iso("01:10"));
    });
  });

  describe("Sentry 상태 따라가기", () => {
    it.each([["issue.resolved"], ["issue.ignored"]] as const)("%s이면 열린 incident를 닫는다", async (kind) => {
      await ingest(db, TARGET, [issue()], at("01:00"));
      const summary = await ingest(db, TARGET, [issue({ kind })], at("01:05"));

      expect(summary.resolved).toBe(1);
      expect(await row()).toMatchObject({ status: "resolved", resolvedAt: iso("01:05") });
      expect(await pendingIds(at("01:05"))).toEqual([]);
    });

    it.each([["issue.resolved"], ["issue.ignored"]] as const)("%s이고 행이 없으면 만들지 않는다", async (kind) => {
      const summary = await ingest(db, TARGET, [issue({ kind })], at("01:00"));
      const { rows } = await db.execute("SELECT COUNT(*) AS total FROM incidents");
      expect(summary.ignored).toBe(1);
      expect(Number(rows[0].total)).toBe(0);
    });

    it("상태를 확인할 열린 Sentry incident만 돌려준다", async () => {
      await ingest(db, TARGET, [issue({ lastSeen: iso("00:59") })], at("01:00"));
      await ingest(
        db,
        TARGET,
        [issue({ fingerprint: "sentry:2", sourceId: "2", lastSeen: iso("00:50") }), deployFailed()],
        at("01:00"),
      );
      await ingest(db, TARGET, [issue({ fingerprint: "sentry:3", sourceId: "3" })], at("01:00"));
      await resolveIncident(db, "site-a", "sentry:3", at("01:01"));

      const open = await listOpenSentryIncidents(db, "site-a", 10);
      expect(open.map((incident) => incident.fingerprint)).toEqual(["sentry:2", "sentry:1"]);
      expect(await listOpenSentryIncidents(db, "site-a", 1)).toHaveLength(1);
    });
  });

  describe("음소거", () => {
    it("보내기 전에 음소거하면 알림이 멈추고 미전송으로 세지 않는다", async () => {
      await ingest(db, TARGET, [issue()], at("01:00"));
      await muteIncident(db, "site-a", "sentry:1", at("02:00"), at("01:01"));

      expect(await pendingIds(at("01:01"))).toEqual([]);
      expect(await isDeliveryOverdue(db, at("01:30"))).toBe(false);
    });

    it("음소거 중에는 새 발생이나 등급 상승이 있어도 알리지 않는다", async () => {
      await ingest(db, TARGET, [issue({ count: 1 })], at("01:00"));
      await deliver(at("01:00"));
      await muteIncident(db, "site-a", "sentry:1", at("02:00"), at("01:01"));

      const summary = await ingest(db, TARGET, [issue({ count: 9, lastSeen: iso("01:30") })], at("01:30"));

      expect(summary.escalated).toBe(1);
      expect((await row()).severity).toBe("P1");
      expect(await pendingIds(at("01:30"))).toEqual([]);
    });

    it("음소거 중에 생긴 incident도 알리지 않는다", async () => {
      await muteIncident(db, "site-a", "sentry:1", at("02:00"), at("01:00"));
      await ingest(db, TARGET, [issue({ lastSeen: iso("01:30") })], at("01:30"));

      expect((await row()).status).toBe("open");
      expect(await pendingIds(at("01:30"))).toEqual([]);
      expect(await isDeliveryOverdue(db, at("02:00"))).toBe(false);
    });

    it("음소거 중 재개방은 열기만 하고 알리지 않는다", async () => {
      await ingest(db, TARGET, [issue()], at("01:00"));
      await deliver(at("01:00"));
      await resolveIncident(db, "site-a", "sentry:1", at("01:05"));
      await muteIncident(db, "site-a", "sentry:1", at("02:00"), at("01:05"));

      await ingest(db, TARGET, [issue({ lastSeen: iso("01:30") })], at("01:30"));

      expect(await row()).toMatchObject({ status: "open", episode: 2 });
      expect(await pendingIds(at("01:30"))).toEqual([]);
    });

    it("끝난 뒤 새 발생은 한 번 다시 알린다", async () => {
      await ingest(db, TARGET, [issue()], at("01:00"));
      await deliver(at("01:00"));
      await muteIncident(db, "site-a", "sentry:1", at("02:00"), at("01:01"));

      await ingest(db, TARGET, [issue({ lastSeen: iso("02:01") })], at("02:05"));
      expect(await pendingIds(at("02:05"))).toEqual(["sentry:1"]);
      expect((await row()).pendingSince).toBe(iso("02:05"));

      await deliver(at("02:05"));
      await ingest(db, TARGET, [issue({ lastSeen: iso("02:03") })], at("02:10"));
      await ingest(db, TARGET, [issue({ lastSeen: iso("02:09") })], at("02:15"));
      expect(await pendingIds(at("02:15"))).toEqual([]);
    });

    it("끝난 뒤 새 발생이 없으면 알리지 않는다", async () => {
      await ingest(db, TARGET, [issue()], at("01:00"));
      await deliver(at("01:00"));
      await muteIncident(db, "site-a", "sentry:1", at("02:00"), at("01:01"));

      await ingest(db, TARGET, [issue({ lastSeen: iso("01:59") })], at("02:05"));
      expect(await pendingIds(at("02:05"))).toEqual([]);
    });

    it("끝난 음소거 뒤 해결한 incident가 재발하면 알린다", async () => {
      await ingest(db, TARGET, [issue()], at("01:00"));
      await deliver(at("01:00"));
      await muteIncident(db, "site-a", "sentry:1", at("01:30"), at("01:01"));
      await resolveIncident(db, "site-a", "sentry:1", at("01:10"));

      await ingest(db, TARGET, [issue({ lastSeen: iso("02:00") })], at("02:05"));
      expect(await row()).toMatchObject({ status: "open", episode: 2 });
      expect(await pendingIds(at("02:05"))).toEqual(["sentry:1"]);
    });
  });

  describe("배포 연관", () => {
    it("첫 발생 30분 안의 성공 배포를 근거에 남긴다", async () => {
      await recordDeploys(db, [deploy({ createdAt: iso("00:40") })], at("00:45"));
      await ingest(db, TARGET, [issue({ firstSeen: iso("01:00"), lastSeen: iso("01:00") })], at("01:01"));
      expect((await row()).evidence.relatedDeploy).toEqual({
        deploymentId: "dpl_1",
        sha: "abcdef0",
        createdAt: iso("00:40"),
        readyAt: null,
      });
    });

    it("빌드가 오래 걸려도 공개된 시각부터 30분을 본다", async () => {
      await recordDeploys(db, [deploy({ createdAt: iso("00:00"), readyAt: iso("00:45") })], at("00:46"));
      await ingest(db, TARGET, [issue({ firstSeen: iso("01:00"), lastSeen: iso("01:00") })], at("01:01"));
      expect((await row()).evidence.relatedDeploy).toMatchObject({
        deploymentId: "dpl_1",
        readyAt: iso("00:45"),
      });
    });

    it("여러 개면 가장 최근 배포를 고른다", async () => {
      await recordDeploys(
        db,
        [deploy({ deploymentId: "dpl_old", createdAt: iso("00:35") }), deploy({ deploymentId: "dpl_new", createdAt: iso("00:50") })],
        at("00:55"),
      );
      await ingest(db, TARGET, [issue({ firstSeen: iso("01:00"), lastSeen: iso("01:00") })], at("01:01"));
      expect((await row()).evidence.relatedDeploy?.deploymentId).toBe("dpl_new");
    });

    it.each([
      ["31분 전 배포", deploy({ createdAt: iso("00:29") })],
      ["발생 뒤 배포", deploy({ createdAt: iso("01:05") })],
      ["실패한 배포", deploy({ createdAt: iso("00:50"), state: "ERROR" })],
      ["다른 사이트 배포", deploy({ createdAt: iso("00:50"), target: "site-b" })],
    ])("%s는 연관이 아니다", async (_name, item) => {
      await recordDeploys(db, [item], at("01:10"));
      await ingest(db, TARGET, [issue({ firstSeen: iso("01:00"), lastSeen: iso("01:00") })], at("01:11"));
      expect((await row()).evidence.relatedDeploy).toBeNull();
    });

    it("재개방은 재발 시각으로 다시 판단한다", async () => {
      await recordDeploys(db, [deploy({ createdAt: iso("00:50") })], at("00:55"));
      await ingest(db, TARGET, [issue({ firstSeen: "2026-10-01T00:00:00.000Z" })], at("01:00"));
      expect((await row()).evidence.relatedDeploy).toBeNull();

      await resolveIncident(db, "site-a", "sentry:1", at("01:00"));
      await ingest(db, TARGET, [issue({ lastSeen: iso("01:10") })], at("01:15"));
      expect((await row()).evidence.relatedDeploy?.deploymentId).toBe("dpl_1");
    });

    it("배포 실패 incident에는 표시하지 않는다", async () => {
      await recordDeploys(db, [deploy({ createdAt: iso("00:50") })], at("00:55"));
      await ingest(db, TARGET, [deployFailed({ firstSeen: iso("01:00") })], at("01:01"));
      expect((await row("vercel:dpl_1:ERROR")).evidence.relatedDeploy).toBeNull();
    });
  });

  describe("배포 실패", () => {
    it("P1로 알리고, 다시 읽어도 또 알리지 않는다", async () => {
      await ingest(db, TARGET, [deployFailed()], at("01:00"));
      expect(await row("vercel:dpl_1:ERROR")).toMatchObject({ severity: "P1", area: "전체" });

      await deliver(at("01:00"), "vercel:dpl_1:ERROR");
      await ingest(db, TARGET, [deployFailed()], at("01:05"));
      expect(await pendingIds(at("01:05"))).toEqual([]);
    });

    it("해결한 뒤 같은 실패를 다시 읽어도 열지 않는다", async () => {
      await ingest(db, TARGET, [deployFailed()], at("01:00"));
      await resolveIncident(db, "site-a", "vercel:dpl_1:ERROR", at("01:05"));
      await ingest(db, TARGET, [deployFailed()], at("01:10"));
      expect((await row("vercel:dpl_1:ERROR")).status).toBe("resolved");
    });
  });

  describe("배포 실패 재개방", () => {
    it("해결한 배포 실패는 더 늦은 발생 시각이 와도 다시 열지 않는다(같은 배포는 두 번 실패하지 않음)", async () => {
      await ingest(db, TARGET, [deployFailed({ lastSeen: iso("01:04") })], at("01:00"));
      await resolveIncident(db, TARGET.id, "vercel:dpl_1:ERROR", at("01:01"));
      const summary = await ingest(db, TARGET, [deployFailed({ lastSeen: iso("01:04") })], at("01:02"));

      expect(summary.reopened).toBe(0);
      expect(await row("vercel:dpl_1:ERROR")).toMatchObject({ status: "resolved", episode: 1 });
    });

    it("Sentry issue는 해결 뒤 새로 발생하면 그대로 다시 연다", async () => {
      await ingest(db, TARGET, [issue()], at("01:00"));
      await resolveIncident(db, TARGET.id, "sentry:1", at("01:01"));
      const summary = await ingest(db, TARGET, [issue({ count: 2, lastSeen: iso("01:05") })], at("01:05"));
      expect(summary.reopened).toBe(1);
    });
  });

  describe("교차 사이트", () => {
    it("5분 안에 다른 사이트에도 에러가 있으면 알려 준다", async () => {
      await ingest(db, TARGET, [issue({ lastSeen: iso("01:00") })], at("01:01"));
      await ingest(db, OTHER, [issue({ target: "site-b", lastSeen: iso("01:04") })], at("01:05"));
      expect(await findCorrelatedTargets(db, await row())).toEqual(["site-b"]);
    });

    it("5분이 넘게 떨어지면 관련 없다", async () => {
      await ingest(db, TARGET, [issue({ lastSeen: iso("01:00") })], at("01:01"));
      await ingest(db, OTHER, [issue({ target: "site-b", lastSeen: iso("01:06") })], at("01:07"));
      expect(await findCorrelatedTargets(db, await row())).toEqual([]);
    });

    it("자기 사이트와 배포 실패는 세지 않는다", async () => {
      await ingest(db, TARGET, [issue({ lastSeen: iso("01:00") })], at("01:01"));
      await ingest(db, TARGET, [issue({ fingerprint: "sentry:2", sourceId: "2", lastSeen: iso("01:00") })], at("01:01"));
      await ingest(db, OTHER, [deployFailed({ target: "site-b", lastSeen: iso("01:00") })], at("01:01"));
      expect(await findCorrelatedTargets(db, await row())).toEqual([]);
    });
  });

  describe("알림 전달", () => {
    it("등급 높은 순으로 돌려준다", async () => {
      const adminTitle = maskLogMessage("[admin] 저장 실패");
      const authTitle = maskLogMessage("[auth] 로그인 실패");
      await ingest(
        db,
        TARGET,
        [
          issue({ fingerprint: "sentry:p3", title: adminTitle, tag: tagOf(adminTitle) }),
          issue({ fingerprint: "sentry:p2" }),
          issue({ fingerprint: "sentry:p1", title: authTitle, tag: tagOf(authTitle) }),
        ],
        at("01:00"),
      );
      expect(await pendingIds(at("01:00"))).toEqual(["sentry:p1", "sentry:p2", "sentry:p3"]);
    });

    it("동시에 전송을 시작해도 한쪽만 표를 받는다", async () => {
      await ingest(db, TARGET, [issue()], at("01:00"));
      const { id } = await row();

      const claims = await Promise.all([
        claimNotification(db, id, at("01:00")),
        claimNotification(db, id, at("01:00")),
      ]);

      expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
      expect(await pendingIds(at("01:00"))).toEqual([]);
    });

    it("전송에 실패하면 다음 실행이 다시 보낸다", async () => {
      await ingest(db, TARGET, [issue()], at("01:00"));
      const { id } = await row();
      const claim = await claimNotification(db, id, at("01:00"));
      await releaseNotification(db, id, claim!);

      expect(await pendingIds(at("01:05"))).toEqual(["sentry:1"]);
      expect(await claimNotification(db, id, at("01:05"))).not.toBeNull();
    });

    it("전송 도중 함수가 죽어도 10분 뒤 다시 보낸다", async () => {
      await ingest(db, TARGET, [issue()], at("01:00"));
      const { id } = await row();
      await claimNotification(db, id, at("01:00"));

      expect(await pendingIds(at("01:09"))).toEqual([]);
      expect(await claimNotification(db, id, at("01:09"))).toBeNull();
      expect(await pendingIds(at("01:10"))).toEqual(["sentry:1"]);
      expect(await claimNotification(db, id, at("01:10"))).not.toBeNull();
    });

    it("전송을 마치면 다시 보내지 않고 Slack 위치를 남긴다", async () => {
      await ingest(db, TARGET, [issue()], at("01:00"));
      const { id } = await row();
      const claim = await claimNotification(db, id, at("01:00"));

      expect(await completeNotification(db, id, claim!, "111.222", at("01:00"))).toBe(true);
      expect(await row()).toMatchObject({ notifiedAt: iso("01:00"), slackTs: "111.222", pendingSince: null });
      expect(await claimNotification(db, id, at("02:00"))).toBeNull();
      expect(await pendingIds(at("02:00"))).toEqual([]);
    });

    it("보내는 동안 등급이 오르면 이전 전송의 완료가 새 알림을 지우지 않는다", async () => {
      await ingest(db, TARGET, [issue({ count: 1 })], at("01:00"));
      const { id } = await row();
      const claim = await claimNotification(db, id, at("01:00"));
      await ingest(db, TARGET, [issue({ count: 9, lastSeen: iso("01:09") })], at("01:10"));

      expect(await completeNotification(db, id, claim!, "111.222", at("01:10"))).toBe(false);
      expect(await row()).toMatchObject({ severity: "P1", notifiedAt: null });
      expect(await pendingIds(at("01:10"))).toEqual(["sentry:1"]);
    });

    it("보내는 동안 해결 뒤 재개방되면 이전 전송의 완료는 무효다", async () => {
      await ingest(db, TARGET, [issue()], at("01:00"));
      const { id } = await row();
      const claim = await claimNotification(db, id, at("01:00"));
      await resolveIncident(db, "site-a", "sentry:1", at("01:02"));
      await ingest(db, TARGET, [issue({ lastSeen: iso("01:05") })], at("01:06"));

      expect(await completeNotification(db, id, claim!, "111.222", at("01:06"))).toBe(false);
      expect(await row()).toMatchObject({ episode: 2, notifiedAt: null });
      expect(await pendingIds(at("01:06"))).toEqual(["sentry:1"]);
    });

    it("다른 실행이 다시 받은 표는 이전 표로 완료하거나 취소할 수 없다", async () => {
      await ingest(db, TARGET, [issue()], at("01:00"));
      const { id } = await row();
      const first = await claimNotification(db, id, at("01:00"));
      const second = await claimNotification(db, id, at("01:10"));

      await releaseNotification(db, id, first!);
      expect(await pendingIds(at("01:11"))).toEqual([]);
      expect(await completeNotification(db, id, first!, null, at("01:11"))).toBe(false);
      expect(await completeNotification(db, id, second!, "222.333", at("01:11"))).toBe(true);
    });

    it("다시 알릴 때 Slack 위치 없이 끝나도 기존 위치를 지우지 않는다", async () => {
      await ingest(db, TARGET, [issue({ count: 1 })], at("01:00"));
      await deliver(at("01:00"), "sentry:1", "111.222");
      await ingest(db, TARGET, [issue({ count: 9, lastSeen: iso("01:09") })], at("01:10"));
      await deliver(at("01:10"), "sentry:1", null);
      expect((await row()).slackTs).toBe("111.222");
    });

    it("해결한 incident는 전송을 시작할 수 없다", async () => {
      await ingest(db, TARGET, [issue()], at("01:00"));
      const { id } = await row();
      await resolveIncident(db, "site-a", "sentry:1", at("01:01"));
      expect(await claimNotification(db, id, at("01:02"))).toBeNull();
    });
  });

  describe("동시 실행", () => {
    beforeEach(async () => {
      await ingest(db, TARGET, [issue({ count: 1 })], at("01:00"));
      await deliver(at("01:00"));
    });

    it("읽은 뒤 다른 실행이 올린 등급과 횟수를 되돌리지 않는다", async () => {
      const raced = interleave(db, () =>
        ingest(db, TARGET, [issue({ count: 9, lastSeen: iso("01:09") })], at("01:10")),
      );
      const summary = await ingest(raced, TARGET, [issue({ count: 2, lastSeen: iso("01:05") })], at("01:10"));

      expect(summary.ignored).toBe(1);
      expect(await row()).toMatchObject({ severity: "P1", lastSeen: iso("01:09"), evidence: { count: 9 } });
      expect(await pendingIds(at("01:10"))).toEqual(["sentry:1"]);
    });

    it("다시 읽어 더 최근 값을 반영한다", async () => {
      const raced = interleave(db, () =>
        ingest(db, TARGET, [issue({ count: 2, lastSeen: iso("01:05") })], at("01:10")),
      );
      const summary = await ingest(raced, TARGET, [issue({ count: 9, lastSeen: iso("01:09") })], at("01:10"));

      expect(summary).toMatchObject({ updated: 1, escalated: 1 });
      expect(await row()).toMatchObject({ severity: "P1", evidence: { count: 9 } });
    });

    it("읽은 뒤 음소거됐으면 오른 등급을 알리지 않는다", async () => {
      const raced = interleave(db, () => muteIncident(db, "site-a", "sentry:1", at("02:00"), at("01:09")));
      await ingest(raced, TARGET, [issue({ count: 9, lastSeen: iso("01:09") })], at("01:10"));

      expect((await row()).severity).toBe("P1");
      expect(await pendingIds(at("01:10"))).toEqual([]);
    });

    it("같은 새 incident를 동시에 만들면 늦은 쪽은 갱신으로 처리한다", async () => {
      const second = { fingerprint: "sentry:2", sourceId: "2" };
      const raced = interleave(db, () => ingest(db, TARGET, [issue({ ...second, count: 1 })], at("01:00")));
      const summary = await ingest(raced, TARGET, [issue({ ...second, count: 4 })], at("01:00"));

      expect(summary).toMatchObject({ created: 0, updated: 1 });
      expect((await row("sentry:2")).evidence.count).toBe(4);
    });

    it("충돌이 계속되면 실패를 알린다", async () => {
      const raced = interleave(
        db,
        () => db.execute("UPDATE incidents SET version = version + 1"),
        Number.POSITIVE_INFINITY,
      );
      await expect(
        ingest(raced, TARGET, [issue({ count: 2, lastSeen: iso("01:05") })], at("01:05")),
      ).rejects.toThrow("3번 연속 충돌");
    });

    it("늦게 도착한 옛 응답은 무시한다", async () => {
      await ingest(db, TARGET, [issue({ count: 9, lastSeen: iso("01:09") })], at("01:10"));
      const summary = await ingest(db, TARGET, [issue({ count: 2, lastSeen: iso("01:05") })], at("01:11"));

      expect(summary.ignored).toBe(1);
      expect((await row()).evidence.count).toBe(9);
    });

    it("같은 시각의 응답이 더 작은 누적값을 주면 큰 값을 유지한다", async () => {
      await ingest(db, TARGET, [issue({ count: 9, lastSeen: iso("01:09") })], at("01:10"));
      await ingest(db, TARGET, [issue({ count: 2, lastSeen: iso("01:09") })], at("01:11"));
      expect((await row()).evidence.count).toBe(9);
    });

    it("늦게 도착한 옛 해결 상태는 열린 incident를 닫지 않는다", async () => {
      await ingest(db, TARGET, [issue({ count: 2, lastSeen: iso("01:09") })], at("01:10"));
      const summary = await ingest(db, TARGET, [issue({ kind: "issue.resolved", lastSeen: iso("01:05") })], at("01:11"));

      expect(summary.ignored).toBe(1);
      expect((await row()).status).toBe("open");
    });
  });

  describe("미전송 대기", () => {
    it("15분이 지나면 알린다", async () => {
      await ingest(db, TARGET, [issue()], at("01:00"));
      expect(await isDeliveryOverdue(db, at("01:14"))).toBe(false);
      expect(await isDeliveryOverdue(db, at("01:15"))).toBe(true);
    });

    it("사이트 범위를 주면 그 사이트만 본다", async () => {
      await ingest(db, TARGET, [issue()], at("01:00"));
      expect(await isDeliveryOverdue(db, at("01:15"), ["site-a"])).toBe(true);
      expect(await isDeliveryOverdue(db, at("01:15"), ["site-b"])).toBe(false);
      expect(await isDeliveryOverdue(db, at("01:15"), [])).toBe(false);
    });

    it("새 발생이 이어져도 대기 시간은 처음부터 잰다", async () => {
      await ingest(db, TARGET, [issue({ count: 1 })], at("01:00"));
      await ingest(db, TARGET, [issue({ count: 1, lastSeen: iso("01:14") })], at("01:14"));
      expect(await isDeliveryOverdue(db, at("01:15"))).toBe(true);
    });

    it("보내지 못한 채 등급이 올라도 대기 시간을 다시 재지 않는다", async () => {
      await ingest(db, TARGET, [issue({ count: 1 })], at("01:00"));
      await ingest(db, TARGET, [issue({ count: 9 })], at("01:10"));

      expect(await row()).toMatchObject({ severity: "P1", pendingSince: iso("01:00") });
      expect(await isDeliveryOverdue(db, at("01:15"))).toBe(true);
    });

    it("전송 중 표시가 남아 있어도 미전송으로 센다", async () => {
      await ingest(db, TARGET, [issue()], at("01:00"));
      await claimNotification(db, (await row()).id, at("01:00"));
      expect(await isDeliveryOverdue(db, at("01:15"))).toBe(true);
    });

    it("전달했거나 해결하면 세지 않는다", async () => {
      await ingest(db, TARGET, [issue()], at("01:00"));
      await ingest(db, TARGET, [issue({ fingerprint: "sentry:2", sourceId: "2" })], at("01:00"));
      await deliver(at("01:01"));
      await resolveIncident(db, "site-a", "sentry:2", at("01:01"));
      expect(await isDeliveryOverdue(db, at("02:00"))).toBe(false);
    });
  });

  describe("recordDeploys", () => {
    const state = async () => {
      const { rows } = await db.execute("SELECT state, sha, ready_at, updated_at FROM deploys");
      return rows[0];
    };

    it("진행 상태에서 최종 상태로 바꾼다", async () => {
      await recordDeploys(db, [deploy({ state: "BUILDING", sha: null })], at("01:00"));
      await recordDeploys(db, [deploy({ state: "ERROR" })], at("01:05"));
      expect(await state()).toMatchObject({ state: "ERROR", sha: "abcdef0", updated_at: iso("01:05") });
    });

    it("늦게 도착한 과거 상태는 무시한다", async () => {
      await recordDeploys(db, [deploy({ state: "ERROR" })], at("01:05"));
      await recordDeploys(db, [deploy({ state: "BUILDING" })], at("01:06"));
      expect(await state()).toMatchObject({ state: "ERROR", updated_at: iso("01:05") });
    });

    it("공개 시각을 남기고, 늦게 온 과거 상태가 지우지 않는다", async () => {
      await recordDeploys(db, [deploy({ state: "BUILDING" })], at("00:41"));
      await recordDeploys(db, [deploy({ state: "READY", readyAt: iso("00:45") })], at("00:46"));
      await recordDeploys(db, [deploy({ state: "BUILDING" })], at("00:47"));
      expect(await state()).toMatchObject({ state: "READY", ready_at: iso("00:45") });
    });

    it("최종 상태가 바뀌어도 공개 시각은 지우지 않는다", async () => {
      await recordDeploys(db, [deploy({ state: "READY", readyAt: iso("00:45") })], at("00:46"));
      await recordDeploys(db, [deploy({ state: "DELETED" })], at("02:00"));
      expect(await state()).toMatchObject({ state: "DELETED", ready_at: iso("00:45") });
    });

    it("같은 배포를 두 번 받아도 한 행이다", async () => {
      await recordDeploys(db, [deploy()], at("01:00"));
      await recordDeploys(db, [deploy()], at("01:05"));
      const { rows } = await db.execute("SELECT COUNT(*) AS total FROM deploys");
      expect(Number(rows[0].total)).toBe(1);
    });

    it("빈 목록을 받아도 실패하지 않는다", async () => {
      await expect(recordDeploys(db, [], at("01:00"))).resolves.toBeUndefined();
    });
  });

  describe("실행 단위 전송 표", () => {
    const signals = () => [
      issue({ fingerprint: "sentry:1", sourceId: "1" }),
      issue({
        fingerprint: "sentry:2",
        sourceId: "2",
        title: maskLogMessage("[auth] 로그인 실패"),
        tag: tagOf(maskLogMessage("[auth] 로그인 실패")),
      }),
      issue({ fingerprint: "sentry:3", sourceId: "3" }),
    ];

    it("미전송 전부에 표를 붙이고 등급 높은 순으로 돌려준다", async () => {
      await ingest(db, TARGET, signals(), at("01:00"));
      const { claim, incidents } = await claimPending(db, TARGET.id, at("01:00"));

      expect(incidents.map((i) => i.fingerprint)).toEqual(["sentry:2", "sentry:1", "sentry:3"]);
      expect((await listClaimed(db, claim)).map((i) => i.fingerprint)).toEqual(["sentry:2", "sentry:1", "sentry:3"]);
      // 다른 실행은 같은 incident를 받지 못한다
      expect((await claimPending(db, TARGET.id, at("01:01"))).incidents).toEqual([]);
      expect(await claimNotification(db, incidents[0].id, at("01:01"))).toBeNull();
    });

    it("다른 실행이 보내는 중인 incident와 다른 사이트는 받지 않는다", async () => {
      await ingest(db, TARGET, signals(), at("01:00"));
      await ingest(db, OTHER, [issue({ target: "site-b" })], at("01:00"));
      await claimNotification(db, (await row("sentry:1")).id, at("01:00"));

      const { incidents } = await claimPending(db, TARGET.id, at("01:00"));
      expect(incidents.map((i) => i.fingerprint)).toEqual(["sentry:2", "sentry:3"]);
    });

    it("등급이 오르면 그 incident의 표만 무효가 된다", async () => {
      await ingest(db, TARGET, signals(), at("01:00"));
      const { claim, incidents } = await claimPending(db, TARGET.id, at("01:00"));
      await ingest(db, TARGET, [issue({ count: 5, lastSeen: iso("01:01") })], at("01:01"));

      const sentry1 = incidents.find((i) => i.fingerprint === "sentry:1");
      expect(await getClaimedIncident(db, sentry1!.id, claim)).toBeNull();
      expect((await listClaimed(db, claim)).map((i) => i.fingerprint)).toEqual(["sentry:2", "sentry:3"]);
    });

    it("묶음 완료는 표가 유효한 건만 기록하고, 남은 표는 한 번에 돌려준다", async () => {
      await ingest(db, TARGET, signals(), at("01:00"));
      const { claim, incidents } = await claimPending(db, TARGET.id, at("01:00"));
      const [first, second, third] = incidents;
      await muteIncident(db, TARGET.id, third.fingerprint, at("02:00"), at("01:00"));

      expect(await completeNotifications(db, [second.id, third.id], claim, "9.9", at("01:01"))).toBe(1);
      expect((await row(second.fingerprint)).slackTs).toBe("9.9");
      expect(await completeNotifications(db, [], claim, "9.9", at("01:01"))).toBe(0);

      await releaseClaim(db, claim);
      expect(await getClaimedIncident(db, first.id, claim)).toBeNull();
      expect((await listPending(db, TARGET.id, at("01:01"))).map((i) => i.fingerprint)).toEqual([first.fingerprint]);
    });

    it("회차를 주면 그 회차가 열려 있을 때만 해결한다", async () => {
      await ingest(db, TARGET, [issue()], at("01:00"));
      expect(await resolveIncident(db, TARGET.id, "sentry:1", at("01:01"), 2)).toBe(false);
      expect((await row()).status).toBe("open");
      expect(await resolveIncident(db, TARGET.id, "sentry:1", at("01:01"), 1)).toBe(true);
      expect((await row()).status).toBe("resolved");
    });
  });

  describe("커서", () => {
    it("사이트와 출처별로 저장하고 덮어쓴다", async () => {
      expect(await getCursor(db, "site-a", "sentry")).toBeNull();

      await saveCursor(db, "site-a", "sentry", iso("01:00"), at("01:00"));
      await saveCursor(db, "site-a", "sentry", iso("01:05"), at("01:05"));
      await saveCursor(db, "site-a", "vercel", iso("01:01"), at("01:01"));

      expect(await getCursor(db, "site-a", "sentry")).toBe(iso("01:05"));
      expect(await getCursor(db, "site-a", "vercel")).toBe(iso("01:01"));
      expect(await getCursor(db, "site-b", "sentry")).toBeNull();
    });
  });

  describe("잠금", () => {
    it("잡혀 있으면 실패하고 만료되면 잡을 수 있다", async () => {
      // TTL 3분: collect의 maxDuration(120초)보다 길고 Cron 주기(5분)보다 짧다
      expect(await acquireLock(db, "collect", "run-1", at("01:00"))).toBe(true);
      expect(await acquireLock(db, "collect", "run-2", at("01:02"))).toBe(false);
      expect(await acquireLock(db, "collect", "run-2", at("01:03"))).toBe(true);
    });

    it("동시에 잡아도 하나만 성공한다", async () => {
      const results = await Promise.all([
        acquireLock(db, "collect", "run-1", at("01:00")),
        acquireLock(db, "collect", "run-2", at("01:00")),
        acquireLock(db, "collect", "run-3", at("01:00")),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("풀면 바로 잡을 수 있다", async () => {
      await acquireLock(db, "collect", "run-1", at("01:00"));
      await releaseLock(db, "collect", "run-1");
      expect(await acquireLock(db, "collect", "run-2", at("01:01"))).toBe(true);
    });

    it("만료 뒤 다른 실행이 잡은 잠금을 예전 실행이 풀지 못한다", async () => {
      await acquireLock(db, "collect", "run-1", at("01:00"));
      await acquireLock(db, "collect", "run-2", at("01:05"));
      await releaseLock(db, "collect", "run-1");
      expect(await acquireLock(db, "collect", "run-3", at("01:06"))).toBe(false);
    });

    it("이름이 다르면 따로 잡는다", async () => {
      expect(await acquireLock(db, "collect", "run-1", at("01:00"))).toBe(true);
      expect(await acquireLock(db, "purge", "run-1", at("01:00"))).toBe(true);
    });
  });

  describe("purgeExpired", () => {
    const NOW = new Date("2027-06-01T00:00:00.000Z");
    const OLD = new Date("2026-11-07T00:00:00.000Z");
    const count = async (table: string) => {
      const { rows } = await db.execute(`SELECT COUNT(*) AS total FROM ${table}`);
      return Number(rows[0].total);
    };

    it("180일 지난 해결 incident·배포·음소거와 만료된 잠금을 지운다", async () => {
      await ingest(db, TARGET, [issue()], OLD);
      await resolveIncident(db, "site-a", "sentry:1", OLD);
      await recordDeploys(db, [deploy({ createdAt: OLD.toISOString() })], OLD);
      await muteIncident(db, "site-a", "sentry:9", OLD, OLD);
      await acquireLock(db, "collect", "run-1", OLD);
      await reserveAnalysisCall(db, OLD, 50);
      await reserveCommandCall(db, "eval", OLD, 3);

      await purgeExpired(db, NOW);

      expect(await count("incidents")).toBe(0);
      expect(await count("deploys")).toBe(0);
      expect(await count("mutes")).toBe(0);
      expect(await count("locks")).toBe(0);
      expect(await count("analysis_usage")).toBe(0);
      expect(await count("command_usage")).toBe(0);
    });

    it("받은 Slack 요청은 1시간만 남긴다", async () => {
      await claimSlackRequest(db, "v0=old", new Date("2027-05-31T22:59:00.000Z"));
      await claimSlackRequest(db, "v0=new", new Date("2027-05-31T23:01:00.000Z"));

      await purgeExpired(db, NOW);

      const { rows } = await db.execute("SELECT id FROM slack_requests");
      expect(rows.map((r) => r.id)).toEqual(["v0=new"]);
    });

    it("실행 기록은 7일만 남긴다", async () => {
      const run = (startedAt: string): CollectRun => ({
        caller: "cron",
        startedAt,
        finishedAt: startedAt,
        status: "done",
        stepsOk: 1,
        stepsTotal: 1,
        heartbeat: "sent",
      });
      await recordRun(db, run("2027-05-24T23:59:00.000Z"));
      await recordRun(db, run("2027-05-25T00:01:00.000Z"));

      await purgeExpired(db, NOW);

      const { rows } = await db.execute("SELECT started_at FROM collect_runs");
      expect(rows.map((r) => r.started_at)).toEqual(["2027-05-25T00:01:00.000Z"]);
    });

    it("열린 incident와 최근 행은 남긴다", async () => {
      await ingest(db, TARGET, [issue()], OLD);
      await recordDeploys(db, [deploy({ createdAt: "2027-05-30T00:00:00.000Z" })], NOW);
      await muteIncident(db, "site-a", "sentry:9", new Date("2027-05-30T00:00:00.000Z"), NOW);
      await acquireLock(db, "collect", "run-1", NOW);
      await reserveAnalysisCall(db, NOW, 50);
      await reserveCommandCall(db, "eval", NOW, 3);

      await purgeExpired(db, NOW);

      expect(await count("incidents")).toBe(1);
      expect(await count("deploys")).toBe(1);
      expect(await count("mutes")).toBe(1);
      expect(await count("locks")).toBe(1);
      expect(await count("analysis_usage")).toBe(1);
      expect(await count("command_usage")).toBe(1);
    });
  });

  describe("Claude 요약 저장·하루 상한", () => {
    const stored = (overrides: Partial<StoredAnalysis> = {}): StoredAnalysis => ({
      key: "1:P2",
      previousTs: null,
      result: {
        summary: "DB 시간 초과로 목록 조회가 실패합니다.",
        suspectedLayer: "DB",
        deployRelated: false,
        crossSite: false,
        userImpact: "목록이 비어 보입니다.",
        nextChecks: ["쿼리 지연 확인"],
        confidence: "중간",
      },
      model: "claude-opus-5-5",
      frames: [maskFrame({ filename: "src/queries.ts", function: "list", line: 3 })],
      correlated: ["site-b"],
      at: iso("01:00"),
      ...overrides,
    });

    it("전송 표를 쥔 동안 요약을 저장하고, 알림 상태와 버전은 그대로다", async () => {
      await ingest(db, TARGET, [issue()], at("01:00"));
      const before = await row();
      expect(before.analysis).toBeNull();

      const { claim } = await claimPending(db, TARGET.id, at("01:01"));
      expect(await saveAnalysis(db, before.id, claim, stored())).toBe(true);
      await releaseClaim(db, claim);
      const after = await row();
      expect(after.analysis).toEqual(stored());
      expect(after.version).toBe(before.version);
      expect(await pendingIds(at("01:02"))).toEqual(["sentry:1"]);
    });

    it("요약을 만드는 사이 표가 무효가 되면(등급 상승 등) 저장하지 않는다", async () => {
      await ingest(db, TARGET, [issue()], at("01:00"));
      const { claim } = await claimPending(db, TARGET.id, at("01:01"));
      // 10분 안에 5번 늘어 등급이 오르면 진행 중인 표가 무효가 된다
      await ingest(db, TARGET, [issue({ count: 6, lastSeen: iso("01:02") })], at("01:02"));

      expect(await saveAnalysis(db, (await row()).id, claim, stored())).toBe(false);
      expect((await row()).analysis).toBeNull();
    });

    it("하루 상한까지만 예약하고, 동시에 불려도 넘지 않는다", async () => {
      const results = await Promise.all(Array.from({ length: 5 }, () => reserveAnalysisCall(db, at("01:00"), 3)));
      expect(results.filter(Boolean)).toHaveLength(3);
      expect(await reserveAnalysisCall(db, at("02:00"), 3)).toBe(false);
      expect(await reserveAnalysisCall(db, at("02:00"), 0)).toBe(false);
    });

    it("날짜는 KST로 센다. 한국 자정(UTC 15시)에 새로 시작한다", async () => {
      expect(await reserveAnalysisCall(db, new Date("2026-11-07T14:59:00.000Z"), 1)).toBe(true);
      expect(await reserveAnalysisCall(db, new Date("2026-11-07T14:59:59.000Z"), 1)).toBe(false);
      expect(await reserveAnalysisCall(db, new Date("2026-11-07T15:00:00.000Z"), 1)).toBe(true);
      const { rows } = await db.execute("SELECT day, calls FROM analysis_usage ORDER BY day");
      expect(rows.map((r) => [r.day, r.calls])).toEqual([
        ["2026-11-07", 1],
        ["2026-11-08", 1],
      ]);
    });
  });

  describe("Slack 명령 사용량·실행 기록·상태", () => {
    const run = (overrides: Partial<CollectRun> = {}): CollectRun => ({
      caller: "cron",
      startedAt: iso("01:00"),
      finishedAt: iso("01:01"),
      status: "done",
      stepsOk: 4,
      stepsTotal: 4,
      heartbeat: "sent",
      ...overrides,
    });
    const status = (now: Date, targetIds: readonly string[] = ["site-a"]) =>
      readOpsStatus(db, { now, lockName: "collect", targetIds });

    it("명령 칸을 예약하면 예약한 뒤의 횟수를, 상한이면 null을 돌려준다. 동시에 불려도 넘지 않는다", async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => reserveCommandCall(db, "eval", at("01:00"), 3)),
      );
      expect(results.filter((n) => n !== null).sort()).toEqual([1, 2, 3]);
      expect(await reserveCommandCall(db, "eval", at("02:00"), 3)).toBeNull();
      expect(await reserveCommandCall(db, "eval", at("02:00"), 0)).toBeNull();
    });

    it("명령 칸은 알림 요약 칸과 따로 세고, 한국 자정(UTC 15시)에 새로 시작한다", async () => {
      expect(await reserveCommandCall(db, "eval", new Date("2026-11-07T14:59:00.000Z"), 1)).toBe(1);
      expect(await reserveCommandCall(db, "eval", new Date("2026-11-07T14:59:30.000Z"), 1)).toBeNull();
      expect(await reserveCommandCall(db, "eval", new Date("2026-11-07T15:00:00.000Z"), 1)).toBe(1);
      expect(await reserveAnalysisCall(db, new Date("2026-11-07T14:59:00.000Z"), 1)).toBe(true);

      const next = await status(new Date("2026-11-07T15:30:00.000Z"));
      expect(next.commandCalls).toEqual({ eval: 1 });
      expect(next.analysisCalls).toBe(0);
      const before = await status(new Date("2026-11-07T14:59:59.000Z"));
      expect(before.commandCalls).toEqual({ eval: 1 });
      expect(before.analysisCalls).toBe(1);
    });

    it("같은 Slack 요청은 처음 한 번만 받는다. 동시에 와도 하나만 받는다", async () => {
      const results = await Promise.all(
        Array.from({ length: 4 }, () => claimSlackRequest(db, "v0=abc", at("01:00"))),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await claimSlackRequest(db, "v0=abc", at("01:04"))).toBe(false);
      expect(await claimSlackRequest(db, "v0=def", at("01:04"))).toBe(true);
    });

    it("기록이 없으면 빈 상태를 돌려준다", async () => {
      expect(await status(at("01:00"))).toEqual({
        lastCron: null,
        lastSlack: null,
        lastHeartbeatAt: null,
        collecting: false,
        pending: 0,
        overdue: false,
        analysisCalls: 0,
        commandCalls: { eval: 0 },
      });
    });

    it("호출자별 마지막 실행과 heartbeat를 마지막으로 보낸 자동 수집 시각을 돌려준다", async () => {
      await recordRun(db, run({ startedAt: iso("00:50"), heartbeat: "sent" }));
      await recordRun(db, run({ startedAt: iso("00:55"), heartbeat: "skipped", stepsOk: 3 }));
      await recordRun(db, run({ caller: "slack", startedAt: iso("00:57"), heartbeat: "disabled" }));
      // 늦게 끝나 나중에 기록된 실행도 시작 시각으로 줄 세운다
      await recordRun(
        db,
        run({ caller: "slack", startedAt: iso("00:53"), status: "locked", stepsOk: 0, stepsTotal: 0, heartbeat: "skipped" }),
      );

      const current = await status(at("01:00"));
      expect(current.lastCron).toEqual(run({ startedAt: iso("00:55"), heartbeat: "skipped", stepsOk: 3 }));
      expect(current.lastSlack).toMatchObject({ caller: "slack", startedAt: iso("00:57"), status: "done" });
      expect(current.lastHeartbeatAt).toBe(iso("00:50"));
    });

    it("수동 실행은 heartbeat 시각으로 세지 않는다", async () => {
      await recordRun(db, run({ caller: "slack", startedAt: iso("00:58"), heartbeat: "sent" }));
      expect((await status(at("01:00"))).lastHeartbeatAt).toBeNull();
    });

    it("기록할 수 없는 값은 표가 거부한다", async () => {
      await expect(recordRun(db, run({ caller: "manual" as CollectRun["caller"] }))).rejects.toThrow(/CHECK/);
      await expect(recordRun(db, run({ heartbeat: "ok" as CollectRun["heartbeat"] }))).rejects.toThrow(/CHECK/);
    });

    it("잠금이 살아 있을 때만 수집 중으로 본다", async () => {
      await acquireLock(db, "collect", "run-1", at("01:00"));
      expect((await status(at("01:01"))).collecting).toBe(true);
      // TTL 3분
      expect((await status(at("01:03"))).collecting).toBe(false);
      await releaseLock(db, "collect", "run-1");
      expect((await status(at("01:01"))).collecting).toBe(false);
    });

    it("미전송 알림은 넘긴 사이트만 세고, 15분 넘게 기다린 것이 있으면 표시한다", async () => {
      await ingest(db, TARGET, [issue()], at("01:00"));
      await ingest(db, OTHER, [issue({ target: "site-b" })], at("01:00"));

      expect(await status(at("01:14"))).toMatchObject({ pending: 1, overdue: false });
      expect(await status(at("01:15"))).toMatchObject({ pending: 1, overdue: true });
      expect(await status(at("01:15"), ["site-a", "site-b"])).toMatchObject({ pending: 2, overdue: true });
      expect(await status(at("01:15"), [])).toMatchObject({ pending: 0, overdue: false });

      await deliver(at("01:16"));
      expect(await status(at("01:16"))).toMatchObject({ pending: 0, overdue: false });
    });
  });
});
