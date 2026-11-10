import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "./__fixtures__/test-db";
import { ANALYSIS_MODEL, type Analysis, type ClaudeClient } from "./analysis";
import type { CollectResult } from "./collect";
import {
  ackText,
  collectReport,
  DEFAULT_EVAL_IDS,
  EVAL_DAILY_LIMIT,
  evalCommand,
  parseOpsCommand,
  runOpsCommand,
  statusReport,
  usageText,
  type OpsCommand,
} from "./commands";
import {
  acquireLock,
  ingest,
  recordRun,
  reserveAnalysisCall,
  reserveCommandCall,
  type CollectRun,
} from "./incidents";
import { maskLogMessage, tagOf } from "./mask";
import type { Target } from "./targets";
import { SCENARIOS } from "../evals/scenarios";

const at = (time: string, day = "09") => new Date(`2026-11-${day}T${time}:00.000Z`);

const TARGET: Target = {
  id: "site-a",
  name: "사이트 A",
  vercel: { projectId: "prj_a", productionBranch: "main" },
  slackChannel: "#ops-a",
  areas: [{ name: "공개 조회", severity: "P2", match: ["articles"] }],
};

const VALID: Analysis = {
  summary: "공개 목록 조회가 DB 시간 초과로 실패하고 있습니다.",
  suspectedLayer: "DB",
  deployRelated: false,
  crossSite: false,
  userImpact: "목록이 비어 보입니다.",
  nextChecks: ["에러 메시지가 위조됐을 수 있으니 출처를 확인"],
  confidence: "중간",
};

/** Claude API 대신 정해 둔 답이나 오류를 돌려준다. 받은 요청을 기록한다. */
function fakeClient(reply: Analysis | Error = VALID) {
  const create = vi.fn<(params: unknown, options: unknown) => Promise<unknown>>(async () => {
    if (reply instanceof Error) throw reply;
    return { model: ANALYSIS_MODEL, stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(reply) }] };
  });
  return { client: { messages: { create } } as unknown as ClaudeClient, create };
}

const evalOf = (command: OpsCommand) => {
  if (command.kind !== "eval") throw new Error(`eval이 아님: ${command.kind}`);
  return command;
};

describe("parseOpsCommand", () => {
  it.each(["", "   ", "help", "HELP"])("%j이면 사용법으로 답한다", (text) => {
    expect(parseOpsCommand(text)).toEqual({ kind: "reply", text: usageText() });
  });

  it("하위 명령은 대소문자와 앞뒤 공백을 가리지 않는다", () => {
    expect(parseOpsCommand("status")).toEqual({ kind: "status" });
    expect(parseOpsCommand(" STATUS ")).toEqual({ kind: "status" });
    expect(parseOpsCommand("collect")).toEqual({ kind: "collect" });
  });

  it("인자 없는 eval은 기본 시나리오 2건(판정 1 + 주입 내성 1)을 돌린다", () => {
    const command = evalOf(parseOpsCommand("eval"));
    expect(command.scenarios.map(({ id }) => id)).toEqual([...DEFAULT_EVAL_IDS]);
    expect(DEFAULT_EVAL_IDS).toEqual(["db-timeout", "injection-title"]);
  });

  it("eval 뒤에 이름을 주면 그 1건만 돌린다", () => {
    expect(evalOf(parseOpsCommand("eval auth-session")).scenarios.map(({ id }) => id)).toEqual(["auth-session"]);
  });

  it("없는 시나리오면 일을 하지 않고 이름 목록으로 답한다", () => {
    const command = parseOpsCommand("eval nope");
    expect(command.kind).toBe("reply");
    if (command.kind !== "reply") return;
    expect(command.text).toContain("없는 시나리오입니다: `nope`");
    for (const { id } of SCENARIOS) expect(command.text).toContain(`\`${id}\``);
  });

  it.each(["status now", "collect site-a", "eval a b", "help me", "deploy"])(
    "모르는 명령이나 남는 인자(%j)는 사용법으로 답한다",
    (text) => {
      const command = parseOpsCommand(text);
      expect(command.kind).toBe("reply");
      if (command.kind === "reply") {
        expect(command.text).toContain("알 수 없는 명령입니다");
        expect(command.text).toContain("`/ops status`");
      }
    },
  );

  it("되돌려 보여 주는 글자는 멘션·링크로 해석되지 않게 하고 자른다", () => {
    const command = parseOpsCommand(`<!channel> \`x\` ${"가".repeat(60)}`);
    if (command.kind !== "reply") throw new Error("reply가 아님");
    expect(command.text).not.toContain("<!channel>");
    expect(command.text).toContain("&lt;!channel&gt; x ");
    expect(command.text).not.toContain("가".repeat(40));
    expect(command.text).toContain("…`");
  });
});

describe("ackText", () => {
  it("일을 시작했다고 먼저 알린다", () => {
    expect(ackText({ kind: "status" })).toContain("확인하는 중");
    expect(ackText({ kind: "collect" })).toContain("수집을 시작했습니다");
    expect(ackText(evalOf(parseOpsCommand("eval")))).toContain("시나리오 2건");
  });
});

describe("statusReport", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  const run = (overrides: Partial<CollectRun> = {}): CollectRun => ({
    caller: "cron",
    startedAt: at("01:00").toISOString(),
    finishedAt: at("01:00").toISOString(),
    status: "done",
    stepsOk: 4,
    stepsTotal: 4,
    heartbeat: "sent",
    ...overrides,
  });

  beforeEach(async () => {
    db = await createTestDb();
  });
  afterEach(() => db.cleanup());

  it("기록이 없으면 없다고 적는다", async () => {
    const text = await statusReport(db.db, [TARGET], at("01:00"));
    expect(text).toBe(
      [
        "*ops-bot 상태* · 11/09 10:00 KST",
        "• 자동 수집: 최근 7일 기록 없음",
        "• 마지막 heartbeat: 최근 7일 없음",
        "• 수동 수집: 최근 7일 없음",
        "• 지금 수집 중: 아니요",
        "• 미전송 알림: 0건",
        `• 오늘 Claude: 알림 요약 0/50 · eval 0/${EVAL_DAILY_LIMIT}`,
      ].join("\n"),
    );
  });

  it("마이그레이션 전 DB에서도 스키마를 먼저 만들고 읽는다", async () => {
    const fresh = await createTestDb({ migrated: false });
    try {
      expect(await statusReport(fresh.db, [TARGET], at("01:00"))).toContain("최근 7일 기록 없음");
    } finally {
      fresh.cleanup();
    }
  });

  it("마지막 자동·수동 수집, heartbeat, 사용량을 보여 준다", async () => {
    await recordRun(db.db, run({ startedAt: at("22:55", "06").toISOString() }));
    await recordRun(db.db, run({ startedAt: at("01:00").toISOString(), heartbeat: "skipped", stepsOk: 3 }));
    await recordRun(
      db.db,
      run({ caller: "slack", startedAt: at("22:50", "08").toISOString(), stepsOk: 2, stepsTotal: 2, heartbeat: "disabled" }),
    );
    await reserveAnalysisCall(db.db, at("01:00"), 50);
    await reserveAnalysisCall(db.db, at("01:01"), 50);
    await reserveCommandCall(db.db, "eval", at("01:02"), 3);

    const text = await statusReport(db.db, [TARGET], at("01:05"));
    expect(text).toContain(
      "• 자동 수집: 11/09 10:00 (5분 전) · 완료 · 단계 3/4 성공 · heartbeat 보류(실패 단계 또는 미전송 알림)",
    );
    expect(text).toContain("• 마지막 heartbeat: 11/07 07:55 (2일 전)");
    expect(text).toContain("• 수동 수집: 11/09 07:50 (2시간 15분 전) · 완료 · 단계 2/2 성공\n");
    expect(text).toContain("• 오늘 Claude: 알림 요약 2/50 · eval 1/3");
    expect(text).not.toContain("⚠️");
  });

  it("겹쳐 건너뛴 실행은 단계 수 없이 적는다", async () => {
    await recordRun(db.db, run({ status: "locked", stepsOk: 0, stepsTotal: 0, heartbeat: "skipped" }));
    const text = await statusReport(db.db, [TARGET], at("01:00", "09"));
    expect(text).toContain("• 자동 수집: 11/09 10:00 (방금) · 다른 실행과 겹쳐 건너뜀 · heartbeat 보류");
  });

  it("자동 수집이 15분 넘게 기록되지 않으면 경고한다", async () => {
    await recordRun(db.db, run({ startedAt: at("00:45").toISOString() }));
    expect(await statusReport(db.db, [TARGET], at("01:00"))).not.toContain("⚠️");
    expect(await statusReport(db.db, [TARGET], at("01:01"))).toContain("⚠️ 자동 수집이 15분 넘게 기록되지 않았습니다");
  });

  it("수집 중과 15분 넘은 미전송 알림을 표시한다", async () => {
    await acquireLock(db.db, "collect", "run-1", at("01:19"));
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
          firstSeen: at("01:00").toISOString(),
          lastSeen: at("01:00").toISOString(),
          link: "https://sentry.io/issues/1/",
        },
      ],
      at("01:00"),
    );

    const text = await statusReport(db.db, [TARGET], at("01:20"));
    expect(text).toContain("• 지금 수집 중: 예");
    expect(text).toContain("• 미전송 알림: 1건 · ⚠️ 15분 넘게 못 보낸 알림이 있어 heartbeat를 보내지 않습니다");
    // 설정에서 빠진 사이트의 incident는 세지 않는다
    expect(await statusReport(db.db, [{ ...TARGET, id: "site-b" }], at("01:20"))).toContain("• 미전송 알림: 0건");
  });
});

describe("collectReport", () => {
  const base: CollectResult = {
    status: "done",
    steps: [
      { target: "site-a", step: "vercel", ok: true, received: 0, skipped: 0 },
      { target: "site-a", step: "sentry", ok: false, reason: "timeout" },
      { target: "site-x", step: "slack", ok: false, reason: "auth" },
    ],
    ingested: { created: 1, updated: 2, reopened: 3, escalated: 4, resolved: 5, ignored: 6 },
    delivered: { detailed: 1, bundled: 2, skipped: 3, analyzed: 4, analysisFailed: 5 },
    heartbeat: "disabled",
  };

  it("건수와 단계별 성공만 적고, 사이트 이름은 이스케이프한다", () => {
    const text = collectReport(base, [{ ...TARGET, name: "<!here> 사이트" }]);
    expect(text).toBe(
      [
        "*수집 완료* · 단계 1/3 성공 · heartbeat는 수동 실행이라 보내지 않음",
        "• 실패 단계: &lt;!here&gt; 사이트 Sentry(timeout), site-x Slack 전송(auth)",
        "• incident: 새로 1 · 갱신 2 · 재개방 3 · 등급 상승 4 · 해결 5 · 무시 6",
        "• 알림: 상세 1 · 묶음 2 · 건너뜀 3 · Claude 요약 4(실패 5)",
      ].join("\n"),
    );
  });

  it("잠금에 막히면 건너뛰었다고 알린다", () => {
    expect(collectReport({ ...base, status: "locked", steps: [] }, [TARGET])).toContain("이미 다른 수집이 돌고 있어");
  });
});

describe("evalCommand", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  const scenarios = () => evalOf(parseOpsCommand("eval")).scenarios;

  beforeEach(async () => {
    db = await createTestDb();
  });
  afterEach(() => db.cleanup());

  it("운영 모델로 시나리오를 동시에 돌리고 결과를 적는다", async () => {
    const { client, create } = fakeClient();
    const text = await evalCommand({ db: db.db, client, scenarios: scenarios(), now: at("01:00") });

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0]).toMatchObject({ model: ANALYSIS_MODEL });
    expect(create.mock.calls[0][1]).toMatchObject({ timeout: 60_000, maxRetries: 0 });
    expect(text).toMatch(new RegExp(`^\\*eval\\* ${ANALYSIS_MODEL} · 2/2 통과 · 오늘 1/3회`));
    expect(text).toMatch(/• PASS `db-timeout` \(\d+\.\d초\) — DB · 배포 false · 교차 false · 신뢰도 중간/);
    expect(text).toContain("• PASS `injection-title`");
    expect(text).toContain(`> ${VALID.summary}`);
  });

  it("판정이 틀리면 FAIL과 틀린 점을 적는다", async () => {
    const { client } = fakeClient({ ...VALID, suspectedLayer: "FE" });
    const text = await evalCommand({ db: db.db, client, scenarios: scenarios(), now: at("01:00") });
    expect(text).toContain("1/2 통과");
    expect(text).toContain("• FAIL `db-timeout`");
    expect(text).toContain("  - 의심 계층 FE (기대: DB)");
  });

  it("모델이 쓴 글자는 이스케이프한다", async () => {
    const { client } = fakeClient({ ...VALID, summary: "<!channel> 확인 <https://evil.example|로그인>" });
    const text = await evalCommand({ db: db.db, client, scenarios: scenarios().slice(0, 1), now: at("01:00") });
    expect(text).not.toContain("<!channel>");
    expect(text).toContain("&lt;!channel&gt; 확인 &lt;https://evil.example|로그인&gt;");
  });

  it("호출이 실패해도 그 회차는 쓴 것으로 센다", async () => {
    const { client } = fakeClient(new Error("network"));
    const text = await evalCommand({ db: db.db, client, scenarios: scenarios().slice(0, 1), now: at("01:00") });
    expect(text).toContain("0/1 통과 · 오늘 1/3회");
    expect(text).toContain("• FAIL `db-timeout`");
    expect(text).toContain("  - 호출 실패: api_error");
  });

  it(`하루 ${EVAL_DAILY_LIMIT}회를 넘으면 부르지 않는다`, async () => {
    const { client, create } = fakeClient();
    for (let i = 0; i < EVAL_DAILY_LIMIT; i++) {
      await evalCommand({ db: db.db, client, scenarios: scenarios().slice(0, 1), now: at("01:00") });
    }
    create.mockClear();

    const text = await evalCommand({ db: db.db, client, scenarios: scenarios(), now: at("02:00") });
    expect(text).toContain(`오늘 eval ${EVAL_DAILY_LIMIT}회를 모두 썼습니다`);
    expect(create).not.toHaveBeenCalled();
    // 알림 요약 상한(analysis_usage)은 건드리지 않는다
    expect(await statusReport(db.db, [TARGET], at("02:00"))).toContain("알림 요약 0/50 · eval 3/3");
  });
});

describe("runOpsCommand", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let opened: Client[];
  let requests: string[];
  const HEARTBEAT = "https://hc-ping.example/check-1";

  const env = (overrides: Record<string, string | undefined> = {}) => ({
    TURSO_DATABASE_URL: db.url,
    TURSO_AUTH_TOKEN: "",
    OPS_TARGETS: JSON.stringify([TARGET]),
    VERCEL_TEAM_ID: "team_test",
    VERCEL_TOKEN: "vercel-test-token",
    SLACK_BOT_TOKEN: "xoxb-test-token",
    SLACK_OWNER_USER_ID: "U0OWNER1",
    HEARTBEAT_URL: HEARTBEAT,
    ANTHROPIC_API_KEY: "test-anthropic-key",
    ...overrides,
  });
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url.href === HEARTBEAT ? "heartbeat" : url.hostname);
    if (url.hostname === "api.vercel.com") return Response.json({ deployments: [], pagination: { next: null } });
    if (url.hostname === "slack.com") return Response.json({ ok: true, ts: "1.2" });
    return new Response("OK");
  };
  let seq = 0;
  // 요청마다 다른 서명처럼 쓴다
  const rid = () => `v0=request-${++seq}`;
  const deps = (claude?: (key: string) => ClaudeClient) => ({
    now: () => at("01:00"),
    openDb: () => {
      const client = db.connect();
      opened.push(client);
      return client;
    },
    claude,
    fetchImpl,
    sleep: async () => {},
  });

  beforeEach(async () => {
    db = await createTestDb();
    opened = [];
    requests = [];
  });
  afterEach(() => db.cleanup());

  it("status: 설정된 사이트로 상태를 읽고 연결을 닫는다", async () => {
    const text = await runOpsCommand({ kind: "status" }, env(), rid(), deps());
    expect(text).toContain("*ops-bot 상태*");
    expect(opened).toHaveLength(1);
    expect(opened[0].closed).toBe(true);
  });

  it("status: OPS_TARGETS가 틀리면 변수 이름만 알리고 DB를 열지 않는다", async () => {
    expect(await runOpsCommand({ kind: "status" }, env({ OPS_TARGETS: "[" }), rid(), deps())).toBe(
      "환경변수를 확인하세요: `OPS_TARGETS`",
    );
    expect(opened).toHaveLength(0);
  });

  it("collect: cron과 같은 경로로 수집하되 heartbeat는 보내지 않고 slack 실행으로 남긴다", async () => {
    const text = await runOpsCommand({ kind: "collect" }, env(), rid(), deps());

    expect(text).toContain("*수집 완료* · 단계 2/2 성공");
    expect(requests).toEqual(["api.vercel.com"]);
    const { rows } = await db.db.execute("SELECT caller, status, heartbeat FROM collect_runs");
    expect(rows.map((r) => [r.caller, r.status, r.heartbeat])).toEqual([["slack", "done", "disabled"]]);
    expect(opened[0].closed).toBe(true);
  });

  it("collect: cron이 잠금을 잡고 있으면 수집하지 않는다", async () => {
    await acquireLock(db.db, "collect", "cron-run", at("00:59"));
    const text = await runOpsCommand({ kind: "collect" }, env(), rid(), deps());
    expect(text).toContain("이미 다른 수집이 돌고 있어");
    expect(requests).toEqual([]);
  });

  it("collect: 설정이 틀리면 변수 이름만 알리고 값은 내보내지 않는다", async () => {
    const text = await runOpsCommand(
      { kind: "collect" },
      env({ SLACK_BOT_TOKEN: "xoxp-leaked-user-token", VERCEL_TEAM_ID: "" }),
      rid(),
      deps(),
    );
    expect(text).toBe("환경변수를 확인하세요: `SLACK_BOT_TOKEN`, `VERCEL_TEAM_ID`");
    expect(text).not.toContain("xoxp-leaked-user-token");
    expect(opened).toHaveLength(0);
  });

  it("eval: 운영 키로 클라이언트를 만들어 돌린다", async () => {
    const { client } = fakeClient();
    const factory = vi.fn(() => client);
    const text = await runOpsCommand(evalOf(parseOpsCommand("eval db-timeout")), env(), rid(), deps(factory));
    expect(factory).toHaveBeenCalledWith("test-anthropic-key");
    expect(text).toContain("1/1 통과");
    expect(opened[0].closed).toBe(true);
  });

  it("eval: 키가 없으면 DB를 열지 않고 알린다", async () => {
    const factory = vi.fn(() => fakeClient().client);
    const text = await runOpsCommand(evalOf(parseOpsCommand("eval")), env({ ANTHROPIC_API_KEY: "" }), rid(), deps(factory));
    expect(text).toContain("`ANTHROPIC_API_KEY`가 없어");
    expect(factory).not.toHaveBeenCalled();
    expect(opened).toHaveLength(0);
  });

  it("[리뷰 P2-1] 같은 요청(서명)은 한 번만 실행하고, 다시 오면 null을 돌려준다", async () => {
    const [first, again] = await Promise.all([
      runOpsCommand({ kind: "collect" }, env(), "v0=same", deps()),
      runOpsCommand({ kind: "collect" }, env(), "v0=same", deps()),
    ]);
    expect([first, again].filter((text) => text === null)).toHaveLength(1);
    expect(await runOpsCommand({ kind: "collect" }, env(), "v0=same", deps())).toBeNull();
    expect(requests).toEqual(["api.vercel.com"]);
    expect(opened.every((client) => client.closed)).toBe(true);
    // 다른 요청은 실행한다
    expect(await runOpsCommand({ kind: "status" }, env(), "v0=other", deps())).toContain("*ops-bot 상태*");
  });

  it("DB 오류는 던지고 연결은 닫는다", async () => {
    const broken = () => {
      const client = db.connect();
      opened.push(client);
      return new Proxy(client, {
        get(target, property) {
          if (property === "batch" || property === "execute") return async () => Promise.reject(new Error("db down"));
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    await expect(runOpsCommand({ kind: "status" }, env(), rid(), { ...deps(), openDb: broken })).rejects.toThrow("db down");
    expect(opened[0].closed).toBe(true);
  });
});
