import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "./__fixtures__/test-db";
import {
  claimNotification,
  getIncident,
  ingest,
  listPending,
  recordDeploys,
  type Incident,
} from "./incidents";
import { maskLogMessage, tagOf } from "./mask";
import {
  bundleMessage,
  deliverPending,
  DETAIL_LIMIT,
  handleAction,
  incidentMessage,
  MUTE_LONG_MS,
  planReport,
  type Send,
} from "./report";
import type { Signal } from "./signal";
import type { Interaction, SlackBlock, SlackMessage, SlackResponse } from "./slack";
import type { Target } from "./targets";

const at = (time: string) => new Date(`2026-11-07T${time}:00.000Z`);
const iso = (time: string) => at(time).toISOString();
const OWNER = "U0OWNER1";

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

function issue(n: number, tag = "articles", overrides: Partial<Signal> = {}): Signal {
  const title = maskLogMessage(`[${tag}] 조회 실패 ${n}`);
  return {
    target: "site-a",
    source: "sentry",
    kind: "issue.new",
    fingerprint: `sentry:${n}`,
    sourceId: String(n),
    title,
    tag: tagOf(title),
    route: null,
    count: 1,
    users: 0,
    firstSeen: iso("00:59"),
    lastSeen: iso("00:59"),
    link: `https://sentry.io/issues/${n}/`,
    ...overrides,
  };
}

/** 메시지 안의 모든 글자. 이스케이프 검사를 블록 종류와 상관없이 한다. */
function allText(message: { text: string; blocks: SlackBlock[] }): string {
  return JSON.stringify(message);
}

function actionsOf(message: SlackMessage) {
  const block = message.blocks.find((b) => b.type === "actions");
  return block?.type === "actions" ? block.elements : [];
}

function interaction(
  incident: Pick<Incident, "id" | "episode">,
  action: "resolve" | "mute_1h" | "mute_30d" = "resolve",
): Extract<Interaction, { kind: "action" }> {
  return {
    kind: "action",
    userId: OWNER,
    responseUrl: "https://hooks.slack.com/actions/T1/1/abc",
    action,
    incidentId: incident.id,
    episode: incident.episode,
  };
}

describe("report", () => {
  let db: Client;
  let cleanup: () => void;

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
  });
  afterEach(() => cleanup());

  const byFingerprint = async (fingerprint: string): Promise<Incident> => {
    const pending = await listPending(db, TARGET.id, at("02:00"));
    const found = pending.find((incident) => incident.fingerprint === fingerprint);
    if (found) return found;
    const { rows } = await db.execute({
      sql: "SELECT id FROM incidents WHERE fingerprint = ?",
      args: [fingerprint],
    });
    const incident = await getIncident(db, Number(rows[0].id));
    if (!incident) throw new Error("incident가 없습니다");
    return incident;
  };

  /** 보낸 메시지를 기록하는 가짜 Slack. */
  function recorder(fail: (index: number) => boolean = () => false) {
    const sent: SlackMessage[] = [];
    const send: Send = async (message) => {
      const index = sent.length;
      sent.push(message);
      if (fail(index)) throw new Error("Slack 장애");
      return { ts: `1700000000.${String(index).padStart(6, "0")}` };
    };
    return { sent, send };
  }

  describe("incidentMessage", () => {
    it("Sentry에서 온 멘션·링크 문법을 글자로 바꾼다", async () => {
      const title = maskLogMessage("[articles] <!channel> 목록 & 조회 실패");
      await ingest(db, TARGET, [issue(1, "articles", { title, tag: tagOf(title) })], at("01:00"));
      const message = incidentMessage(TARGET, await byFingerprint("sentry:1"));

      expect(allText(message)).not.toContain("<!channel>");
      expect(message.text).toContain("&lt;!channel&gt; 목록 &amp; 조회 실패");
      expect(message.blocks[0]).toMatchObject({ type: "section", text: { verbatim: true } });
    });

    it("설정의 사이트 이름·영역도 이스케이프한다", async () => {
      const target = {
        ...TARGET,
        name: "<!here> 사이트",
        areas: [{ name: "<b>공개</b>", severity: "P2" as const, match: ["articles"] }],
      };
      await ingest(db, target, [issue(1)], at("01:00"));
      const text = allText(incidentMessage(target, await byFingerprint("sentry:1")));

      expect(text).not.toContain("<!here>");
      expect(text).toContain("&lt;!here&gt; 사이트");
      expect(text).toContain("영역 &lt;b&gt;공개&lt;/b&gt;");
    });

    it("제목에 등급·사이트·최근 10분 횟수를 적는다", async () => {
      await ingest(db, TARGET, [issue(1, "articles", { count: 2 })], at("01:00"));
      const message = incidentMessage(TARGET, await byFingerprint("sentry:1"));

      expect(message.text).toBe("[P2][사이트 A] [articles] 조회 실패 1 ×2 (10분)");
      expect(message.channel).toBe("#ops-a");
      const body = message.blocks[0].type === "section" ? message.blocks[0].text.text : "";
      expect(body).toContain("새 에러 · 영역 공개 조회");
      expect(body).toContain("누적 2회 · 영향 사용자 0명");
      // UTC 00:59 = KST 09:59
      expect(body).toContain("처음 11/07 09:59 · 마지막 11/07 09:59 (KST)");
    });

    it("P1만 담당자를 멘션한다", async () => {
      await ingest(db, TARGET, [issue(1, "auth"), issue(2, "articles")], at("01:00"));
      const p1 = incidentMessage(TARGET, await byFingerprint("sentry:1"), { ownerUserId: OWNER });
      const p2 = incidentMessage(TARGET, await byFingerprint("sentry:2"), { ownerUserId: OWNER });

      expect(p1.text.startsWith(`<@${OWNER}> [P1]`)).toBe(true);
      expect(allText(p2)).not.toContain(`<@${OWNER}>`);
      // user ID 형식이 아니면 멘션하지 않는다
      const invalid = incidentMessage(TARGET, await byFingerprint("sentry:1"), {
        ownerUserId: "<!channel>",
      });
      expect(allText(invalid)).not.toContain("<!channel>");
      expect(invalid.text.startsWith("[P1]")).toBe(true);
    });

    it("버튼 값은 incident id와 회차다", async () => {
      await ingest(db, TARGET, [issue(1)], at("01:00"));
      const incident = await byFingerprint("sentry:1");
      const buttons = actionsOf(incidentMessage(TARGET, incident));

      expect(buttons.map((b) => b.action_id)).toEqual(["open_link", "resolve", "mute_1h", "mute_30d"]);
      expect(buttons[0]).toMatchObject({ url: "https://sentry.io/issues/1/", text: { text: "Sentry에서 보기" } });
      for (const button of buttons.slice(1)) {
        expect(button.value).toBe(`${incident.id}:1`);
      }
      // 다시 열린 회차는 그 회차 번호를 싣는다
      const reopened = actionsOf(incidentMessage(TARGET, { ...incident, episode: 2 }));
      expect(reopened.find((b) => b.action_id === "resolve")?.value).toBe(`${incident.id}:2`);
    });

    it("https가 아닌 링크는 버튼을 만들지 않는다", async () => {
      await ingest(db, TARGET, [issue(1)], at("01:00"));
      const incident = await byFingerprint("sentry:1");
      for (const link of ["javascript:alert(1)", "http://sentry.io/issues/1/", "not a url"]) {
        const message = incidentMessage(TARGET, { ...incident, evidence: { ...incident.evidence, link } });
        expect(actionsOf(message).map((b) => b.action_id)).not.toContain("open_link");
      }
    });

    it("배포 실패는 Vercel 링크와 배포 실패 표시를 쓴다", async () => {
      await ingest(
        db,
        TARGET,
        [
          issue(1, "articles", {
            source: "vercel",
            kind: "deploy.failed",
            fingerprint: "vercel:dpl_1:ERROR",
            sourceId: "dpl_1",
            title: maskLogMessage("배포 실패 (BUILD_FAILED)"),
            tag: null,
            link: "https://vercel.com/team/project/1",
          }),
        ],
        at("01:00"),
      );
      const message = incidentMessage(TARGET, await byFingerprint("vercel:dpl_1:ERROR"));

      expect(message.text).toBe("[P1][사이트 A] 배포 실패 (BUILD_FAILED)");
      expect(allText(message)).toContain("배포 실패 · 영역");
      expect(allText(message)).not.toContain("누적");
      expect(actionsOf(message)[0]).toMatchObject({ text: { text: "Vercel에서 보기" } });
    });

    it("배포 직후 incident는 공개된 배포를 적는다", async () => {
      await recordDeploys(
        db,
        [
          {
            target: "site-a",
            deploymentId: "dpl_9",
            sha: "abcdef0123456",
            state: "READY",
            createdAt: iso("00:10"),
            readyAt: iso("00:50"),
          },
        ],
        at("01:00"),
      );
      await ingest(db, TARGET, [issue(1)], at("01:00"));
      const text = allText(incidentMessage(TARGET, await byFingerprint("sentry:1")));
      expect(text).toContain("배포 직후: 11/07 09:50에 공개된 배포 abcdef0");
    });

    it("재발과 다시 알림을 구분한다", async () => {
      await ingest(db, TARGET, [issue(1)], at("01:00"));
      const incident = await byFingerprint("sentry:1");

      expect(allText(incidentMessage(TARGET, { ...incident, episode: 2 }))).toContain("재발 (2회차)");
      expect(allText(incidentMessage(TARGET, { ...incident, slackTs: "1.2" }))).toContain("다시 알림");
    });

    it("처리 결과를 적을 때는 버튼과 멘션을 뺀다", async () => {
      await ingest(db, TARGET, [issue(1, "auth")], at("01:00"));
      const incident = await byFingerprint("sentry:1");
      const resolved = incidentMessage(TARGET, incident, {
        ownerUserId: OWNER,
        state: { kind: "resolved", at: at("02:00"), by: OWNER },
      });
      const muted = incidentMessage(TARGET, incident, {
        state: { kind: "muted", until: at("03:00"), by: OWNER },
      });

      expect(actionsOf(resolved)).toEqual([]);
      expect(resolved.text.startsWith("[P1]")).toBe(true);
      expect(allText(resolved)).toContain(`해결 처리 · 11/07 11:00 · <@${OWNER}>`);
      expect(allText(muted)).toContain("11/07 12:00까지 음소거");
    });
  });

  describe("planReport", () => {
    it("6건이면 등급 높은 순 5건과 묶음 1건으로 나눈다", async () => {
      await ingest(
        db,
        TARGET,
        [issue(1, "admin"), issue(2, "articles"), issue(3, "admin"), issue(4, "auth"), issue(5, "articles"), issue(6, "admin")],
        at("01:00"),
      );
      const { detailed, bundled } = planReport(await listPending(db, TARGET.id, at("01:00")));

      expect(detailed).toHaveLength(DETAIL_LIMIT);
      expect(detailed.map((i) => i.severity)).toEqual(["P1", "P2", "P2", "P3", "P3"]);
      expect(bundled.map((i) => i.severity)).toEqual(["P3"]);
    });

    it("같은 등급은 받은 순서를 유지한다", () => {
      const make = (id: number, severity: "P1" | "P2") => ({ id, severity }) as Incident;
      const { detailed } = planReport([make(1, "P2"), make(2, "P1"), make(3, "P2"), make(4, "P1")]);
      expect(detailed.map((i) => i.id)).toEqual([2, 4, 1, 3]);
    });
  });

  describe("bundleMessage", () => {
    it("20줄까지 적고 나머지는 개수만 적는다", async () => {
      await ingest(db, TARGET, Array.from({ length: 25 }, (_, i) => issue(i + 1)), at("01:00"));
      const incidents = await listPending(db, TARGET.id, at("01:00"));
      const message = bundleMessage(TARGET, incidents);

      const lines = message.blocks.filter((b) => b.type === "section").slice(1);
      expect(lines).toHaveLength(20);
      expect(allText(message)).toContain("그 밖에 5건은 목록에 넣지 않았습니다.");
      expect(message.text).toBe("[사이트 A] 상세 알림 5건 밖의 25건");
      expect(actionsOf(message)).toEqual([]);
    });

    it("제목은 이스케이프하고 링크를 끊는 글자는 인코딩한다", async () => {
      const title = maskLogMessage("[articles] <!channel> 실패");
      await ingest(
        db,
        TARGET,
        [issue(1, "articles", { title, tag: tagOf(title), link: "https://sentry.io/issues/1/?a=1&b=x|y" })],
        at("01:00"),
      );
      const text = allText(bundleMessage(TARGET, await listPending(db, TARGET.id, at("01:00"))));

      expect(text).not.toContain("<!channel>");
      expect(text).toContain("&lt;!channel&gt;");
      expect(text).toContain("<https://sentry.io/issues/1/?a=1&amp;b=x%7Cy|열기>");
    });
  });

  describe("deliverPending", () => {
    it("6건이면 상세 5건과 묶음 1건을 보내고 모두 전달 완료로 둔다", async () => {
      await ingest(db, TARGET, Array.from({ length: 6 }, (_, i) => issue(i + 1, i === 5 ? "auth" : "articles")), at("01:00"));
      const { sent, send } = recorder();

      const result = await deliverPending(db, TARGET, at("01:01"), send, { ownerUserId: OWNER });

      expect(result).toEqual({ detailed: 5, bundled: 1, skipped: 0, error: null });
      expect(sent).toHaveLength(6);
      // P1이 먼저 나가고 담당자를 멘션한다
      expect(sent[0].text).toBe(`<@${OWNER}> [P1][사이트 A] [auth] 조회 실패 6 ×1 (10분)`);
      expect(sent[5].text).toBe("[사이트 A] 상세 알림 5건 밖의 1건");
      expect(await listPending(db, TARGET.id, at("01:01"))).toEqual([]);
      // 묶음으로 보낸 incident는 묶음 메시지 ts를 남긴다
      expect((await byFingerprint("sentry:5")).slackTs).toBe("1700000000.000005");
    });

    it("5건 이하면 묶음 없이 보낸다", async () => {
      await ingest(db, TARGET, [issue(1), issue(2), issue(3)], at("01:00"));
      const { sent, send } = recorder();
      expect(await deliverPending(db, TARGET, at("01:01"), send)).toMatchObject({ detailed: 3, bundled: 0 });
      expect(sent).toHaveLength(3);
    });

    it("같은 실행을 두 번 해도 한 번만 보낸다", async () => {
      await ingest(db, TARGET, [issue(1)], at("01:00"));
      const { sent, send } = recorder();
      await deliverPending(db, TARGET, at("01:01"), send);
      await deliverPending(db, TARGET, at("01:02"), send);
      expect(sent).toHaveLength(1);
    });

    it("Slack이 실패하면 멈추고 남은 incident는 다음 실행이 보낸다", async () => {
      await ingest(db, TARGET, Array.from({ length: 7 }, (_, i) => issue(i + 1)), at("01:00"));
      const down = recorder((index) => index === 1);

      const first = await deliverPending(db, TARGET, at("01:01"), down.send);
      expect(first).toMatchObject({ detailed: 1, bundled: 0 });
      expect(first.error).toBeInstanceOf(Error);
      // 실패한 건부터 바로 다시 보낼 수 있다(표를 돌려줌)
      expect((await listPending(db, TARGET.id, at("01:01"))).length).toBe(6);

      const up = recorder();
      expect(await deliverPending(db, TARGET, at("01:02"), up.send)).toMatchObject({
        detailed: 5,
        bundled: 1,
        error: null,
      });
      expect(up.sent[0].text).toContain("조회 실패 2");
    });

    it("묶음 전송이 실패하면 묶음 incident를 돌려준다", async () => {
      await ingest(db, TARGET, Array.from({ length: 6 }, (_, i) => issue(i + 1)), at("01:00"));
      const { send } = recorder((index) => index === 5);

      const result = await deliverPending(db, TARGET, at("01:01"), send);
      expect(result).toMatchObject({ detailed: 5, bundled: 0 });
      expect((await listPending(db, TARGET.id, at("01:01"))).map((i) => i.fingerprint)).toEqual(["sentry:6"]);
    });

    it("다른 실행이 보내는 중인 incident는 건너뛴다", async () => {
      await ingest(db, TARGET, [issue(1), issue(2)], at("01:00"));
      const other = await byFingerprint("sentry:1");
      const plan = await listPending(db, TARGET.id, at("01:01"));
      // 목록을 읽은 뒤 다른 실행이 표를 가져갔다
      const raced = new Proxy(db, {
        get(target, property) {
          if (property === "execute") {
            let first = true;
            return async (...args: Parameters<Client["execute"]>) => {
              if (first) {
                first = false;
                const result = await target.execute(...args);
                await claimNotification(target, other.id, at("01:01"));
                return result;
              }
              return target.execute(...args);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      expect(plan).toHaveLength(2);

      const { sent, send } = recorder();
      expect(await deliverPending(raced, TARGET, at("01:01"), send)).toMatchObject({ detailed: 1, skipped: 1 });
      expect(sent.map((m) => m.text)).toEqual(["[P2][사이트 A] [articles] 조회 실패 2 ×1 (10분)"]);
    });

    it("목록을 읽은 뒤 등급이 오르면 오른 등급으로 보낸다", async () => {
      await ingest(db, TARGET, [issue(1)], at("01:00"));
      let escalated = false;
      const raced = new Proxy(db, {
        get(target, property) {
          if (property === "execute") {
            return async (...args: Parameters<Client["execute"]>) => {
              const [statement] = args as unknown as [string | { sql: string }];
              const sql = typeof statement === "string" ? statement : statement.sql;
              if (!escalated && sql.includes("SET notify_claimed_at = ?, notify_claim = ?")) {
                escalated = true;
                await ingest(target, TARGET, [issue(1, "articles", { count: 5, lastSeen: iso("01:01") })], at("01:01"));
              }
              return target.execute(...args);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      const { sent, send } = recorder();
      await deliverPending(raced, TARGET, at("01:01"), send);
      expect(escalated).toBe(true);
      expect(sent.map((m) => m.text)).toEqual(["[P1][사이트 A] [articles] 조회 실패 1 ×5 (10분)"]);
    });

    it("보내는 동안 등급이 오르면 완료 기록이 거부되고 다음 실행에서 다시 보낸다", async () => {
      await ingest(db, TARGET, [issue(1)], at("01:00"));
      const sent: string[] = [];
      const send: Send = async (message) => {
        sent.push(message.text);
        if (sent.length === 1) {
          await ingest(db, TARGET, [issue(1, "articles", { count: 5, lastSeen: iso("01:01") })], at("01:01"));
        }
        return { ts: `1.${sent.length}` };
      };

      await deliverPending(db, TARGET, at("01:01"), send);
      expect((await listPending(db, TARGET.id, at("01:01"))).map((i) => i.severity)).toEqual(["P1"]);
      await deliverPending(db, TARGET, at("01:02"), send);
      expect(sent).toEqual([
        "[P2][사이트 A] [articles] 조회 실패 1 ×1 (10분)",
        "[P1][사이트 A] [articles] 조회 실패 1 ×5 (10분)",
      ]);
    });
  });

  describe("handleAction", () => {
    const replaced = (response: SlackResponse) => {
      if (!("blocks" in response)) throw new Error(`원래 메시지를 바꾸지 않았습니다: ${response.text}`);
      return response;
    };

    it("해결하면 상태를 바꾸고 버튼 없는 메시지로 바꾼다", async () => {
      await ingest(db, TARGET, [issue(1)], at("01:00"));
      const incident = await byFingerprint("sentry:1");

      const response = replaced(await handleAction(db, [TARGET], interaction(incident), at("02:00")));
      expect(response.replace_original).toBe(true);
      expect(response.blocks.some((b) => b.type === "actions")).toBe(false);
      expect(JSON.stringify(response)).toContain("해결 처리 · 11/07 11:00");
      expect((await byFingerprint("sentry:1")).status).toBe("resolved");
    });

    it("이미 해결됐으면 누른 사람에게만 알린다", async () => {
      await ingest(db, TARGET, [issue(1)], at("01:00"));
      const incident = await byFingerprint("sentry:1");
      await handleAction(db, [TARGET], interaction(incident), at("02:00"));

      expect(await handleAction(db, [TARGET], interaction(incident), at("02:01"))).toEqual({
        response_type: "ephemeral",
        replace_original: false,
        text: "이미 해결된 incident입니다.",
      });
    });

    it("다시 열린 뒤 옛 회차 메시지로는 해결하지 않는다", async () => {
      await ingest(db, TARGET, [issue(1)], at("01:00"));
      const old = await byFingerprint("sentry:1");
      await handleAction(db, [TARGET], interaction(old), at("01:10"));
      await ingest(db, TARGET, [issue(1, "articles", { kind: "issue.regressed", count: 2, lastSeen: iso("01:20") })], at("01:20"));
      expect((await byFingerprint("sentry:1")).episode).toBe(2);

      const response = await handleAction(db, [TARGET], interaction(old), at("01:21"));
      expect(response).toMatchObject({ response_type: "ephemeral" });
      expect(response.text).toContain("1회차 알림");
      expect((await byFingerprint("sentry:1")).status).toBe("open");
    });

    it.each([
      ["mute_1h", "11/07 11:00까지 음소거", 60 * 60_000],
      ["mute_30d", "12/07 10:00까지 음소거", MUTE_LONG_MS],
    ] as const)("%s는 음소거하고 미전송 알림을 멈춘다", async (action, line, duration) => {
      await ingest(db, TARGET, [issue(1)], at("01:00"));
      const incident = await byFingerprint("sentry:1");

      const response = replaced(await handleAction(db, [TARGET], interaction(incident, action), at("01:00")));
      expect(JSON.stringify(response)).toContain(line);
      const { rows } = await db.execute("SELECT until FROM mutes");
      expect(rows[0].until).toBe(new Date(at("01:00").getTime() + duration).toISOString());
      expect(await listPending(db, TARGET.id, at("01:01"))).toEqual([]);
    });

    it("없는 incident와 설정에 없는 사이트는 누른 사람에게만 알린다", async () => {
      await ingest(db, TARGET, [issue(1)], at("01:00"));
      const incident = await byFingerprint("sentry:1");

      expect(await handleAction(db, [TARGET], interaction({ id: 999, episode: 1 }), at("02:00"))).toMatchObject({
        response_type: "ephemeral",
      });
      expect(await handleAction(db, [], interaction(incident), at("02:00"))).toMatchObject({
        response_type: "ephemeral",
        text: "설정에 없는 사이트의 incident입니다.",
      });
      expect((await byFingerprint("sentry:1")).status).toBe("open");
    });
  });

});
