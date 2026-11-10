import type { Client } from "@libsql/client";
import { grade, SCENARIOS, type Scenario } from "../evals/scenarios";
import { ANALYSIS_MODEL, analyzeIncident, claudeClient, DAILY_ANALYSIS_LIMIT, type ClaudeClient } from "./analysis";
import { LOCK_NAME, runCollect, type CollectDeps, type CollectResult, type StepResult } from "./collect";
import { EnvError, loadCollectEnv, type CollectEnv } from "./env";
import {
  claimSlackRequest,
  openDb,
  prepareDb,
  readOpsStatus,
  reserveCommandCall,
  type CollectRun,
} from "./incidents";
import { kst } from "./report";
import { escapeSlack } from "./slack";
import { parseTargets, TargetsConfigError, type Target } from "./targets";

/** `/ops eval` 하루(KST) 횟수. 알림 요약 상한(50)과 따로 센다. */
export const EVAL_DAILY_LIMIT = 3;
/** 인자 없이 부르면 돌리는 시나리오. 기본 판정 1건 + 주입 내성 1건. */
export const DEFAULT_EVAL_IDS = ["db-timeout", "injection-title"] as const;
// eval은 판정을 보려는 것이라 운영 알림(20초)보다 넉넉히 기다린다. route의 maxDuration 안이다.
const EVAL_TIMEOUT_MS = 60_000;
// 자동 수집이 이보다 오래 기록되지 않으면 status에 경고를 붙인다(cron 5분 × 3).
const STALE_CRON_MS = 15 * 60_000;
const MAX_ECHO = 40;

export type OpsCommand =
  | { kind: "status" }
  | { kind: "collect" }
  | { kind: "eval"; scenarios: readonly Scenario[] }
  // 일을 하지 않고 바로 답하는 경우(사용법, 잘못된 인자)
  | { kind: "reply"; text: string };

/** 사용자가 친 글자를 답에 다시 보여 줄 때. 멘션·링크로 해석되지 않게 하고 자른다. */
function echo(text: string): string {
  const chars = Array.from(text.replace(/[`\s]+/g, " ").trim());
  const clipped = chars.length <= MAX_ECHO ? chars.join("") : `${chars.slice(0, MAX_ECHO - 1).join("")}…`;
  return escapeSlack(clipped);
}

export function usageText(problem?: string): string {
  return [
    ...(problem ? [problem, ""] : []),
    "*ops-bot 명령*",
    "• `/ops status` — 마지막 수집·heartbeat·오늘 Claude 사용량",
    "• `/ops collect` — 지금 수집하고 알림 보내기(cron과 같은 경로, heartbeat는 보내지 않음)",
    `• \`/ops eval [시나리오]\` — 운영 키로 요약 점검(기본 ${DEFAULT_EVAL_IDS.join("·")}, 하루 ${EVAL_DAILY_LIMIT}회)`,
  ].join("\n");
}

/** 명령 뒤 글자를 하위 명령으로 바꾼다. 모르는 말이나 남는 인자는 사용법으로 답한다. */
export function parseOpsCommand(text: string): OpsCommand {
  const [sub, ...args] = text.trim().split(/\s+/).filter(Boolean);
  const name = sub?.toLowerCase();
  if (!name || (name === "help" && args.length === 0)) return { kind: "reply", text: usageText() };

  if ((name === "status" || name === "collect") && args.length === 0) return { kind: name };
  if (name === "eval" && args.length <= 1) {
    const ids = args.length === 0 ? DEFAULT_EVAL_IDS : args;
    const scenarios = ids.map((id) => SCENARIOS.find((scenario) => scenario.id === id));
    if (scenarios.every((scenario) => scenario !== undefined)) return { kind: "eval", scenarios };
    return {
      kind: "reply",
      text: `없는 시나리오입니다: \`${echo(args[0] ?? "")}\`\n이름: ${SCENARIOS.map(({ id }) => `\`${id}\``).join(", ")}`,
    };
  }
  return { kind: "reply", text: usageText(`알 수 없는 명령입니다: \`${echo(text)}\``) };
}

/** 일을 시작했다는 첫 답. Slack의 3초 제한 안에 보낸다. */
export function ackText(command: Exclude<OpsCommand, { kind: "reply" }>): string {
  if (command.kind === "status") return "상태를 확인하는 중입니다…";
  if (command.kind === "collect") return "수집을 시작했습니다. 끝나면 결과를 알려 드립니다(최대 2분).";
  return `eval을 시작했습니다(시나리오 ${command.scenarios.length}건). 끝나면 결과를 알려 드립니다.`;
}

function ago(now: Date, iso: string): string {
  const minutes = Math.floor((now.getTime() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 ${minutes % 60}분 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

const RUN_STATUS: Record<CollectRun["status"], string> = {
  done: "완료",
  locked: "다른 실행과 겹쳐 건너뜀",
  failed: "중간에 실패",
};
const HEARTBEAT: Record<CollectRun["heartbeat"], string> = {
  sent: "heartbeat 보냄",
  skipped: "heartbeat 보류(실패 단계 또는 미전송 알림)",
  failed: "heartbeat 핑 실패",
  disabled: "heartbeat 꺼짐",
};

function runLine(run: CollectRun, now: Date, withHeartbeat: boolean): string {
  const parts = [`${kst(run.startedAt)} (${ago(now, run.startedAt)})`, RUN_STATUS[run.status]];
  if (run.status !== "locked") parts.push(`단계 ${run.stepsOk}/${run.stepsTotal} 성공`);
  if (withHeartbeat) parts.push(HEARTBEAT[run.heartbeat]);
  return parts.join(" · ");
}

/** `/ops status`. 기록은 최근 7일만 있다. */
export async function statusReport(db: Client, targets: readonly Target[], now: Date): Promise<string> {
  await prepareDb(db);
  const status = await readOpsStatus(db, { now, lockName: LOCK_NAME, targetIds: targets.map(({ id }) => id) });
  const lines = [`*ops-bot 상태* · ${kst(now)} KST`];

  const { lastCron } = status;
  if (!lastCron) {
    lines.push("• 자동 수집: 최근 7일 기록 없음");
  } else {
    lines.push(`• 자동 수집: ${runLine(lastCron, now, true)}`);
    if (now.getTime() - Date.parse(lastCron.startedAt) > STALE_CRON_MS) {
      lines.push("  ⚠️ 자동 수집이 15분 넘게 기록되지 않았습니다. Vercel Cron을 확인하세요.");
    }
  }
  lines.push(
    `• 마지막 heartbeat: ${status.lastHeartbeatAt ? `${kst(status.lastHeartbeatAt)} (${ago(now, status.lastHeartbeatAt)})` : "최근 7일 없음"}`,
  );
  lines.push(`• 수동 수집: ${status.lastSlack ? runLine(status.lastSlack, now, false) : "최근 7일 없음"}`);
  lines.push(`• 지금 수집 중: ${status.collecting ? "예" : "아니요"}`);
  lines.push(
    `• 미전송 알림: ${status.pending}건${status.overdue ? " · ⚠️ 15분 넘게 못 보낸 알림이 있어 heartbeat를 보내지 않습니다" : ""}`,
  );
  lines.push(
    `• 오늘 Claude: 알림 요약 ${status.analysisCalls}/${DAILY_ANALYSIS_LIMIT} · eval ${status.commandCalls.eval}/${EVAL_DAILY_LIMIT}`,
  );
  return lines.join("\n");
}

const STEP_NAMES: Record<StepResult["step"], string> = {
  vercel: "Vercel",
  sentry: "Sentry",
  "sentry-status": "Sentry 해결 확인",
  uptime: "외부 감시",
  slack: "Slack 전송",
};

/** 수동 collect 결과. 건수와 단계별 성공만 담는다(incident 내용은 평소처럼 채널 알림으로 나간다). */
export function collectReport(result: CollectResult, targets: readonly Target[]): string {
  if (result.status === "locked") {
    return "이미 다른 수집이 돌고 있어 건너뛰었습니다(cron과 겹침). 알림은 그 실행이 보냅니다. 잠시 뒤 `/ops status`로 확인하세요.";
  }
  const nameOf = (id: string) => escapeSlack(targets.find((target) => target.id === id)?.name ?? id);
  const ok = result.steps.filter((step) => step.ok).length;
  const failed = result.steps.filter((step) => !step.ok);
  const { ingested: i, delivered: d } = result;
  return [
    `*수집 완료* · 단계 ${ok}/${result.steps.length} 성공 · heartbeat는 수동 실행이라 보내지 않음`,
    ...(failed.length > 0
      ? [`• 실패 단계: ${failed.map((s) => `${nameOf(s.target)} ${STEP_NAMES[s.step]}(${s.reason ?? "?"})`).join(", ")}`]
      : []),
    `• incident: 새로 ${i.created} · 갱신 ${i.updated} · 재개방 ${i.reopened} · 등급 상승 ${i.escalated} · 해결 ${i.resolved} · 무시 ${i.ignored}`,
    `• 알림: 상세 ${d.detailed} · 묶음 ${d.bundled} · 건너뜀 ${d.skipped} · Claude 요약 ${d.analyzed}(실패 ${d.analysisFailed})`,
  ].join("\n");
}

/** cron과 같은 실행 경로·같은 잠금. heartbeat는 자동 수집이 살아 있다는 뜻이라 보내지 않는다. */
export async function collectCommand(deps: Omit<CollectDeps, "heartbeatUrl" | "caller">): Promise<string> {
  const result = await runCollect({ ...deps, heartbeatUrl: null, caller: "slack" });
  return collectReport(result, deps.targets);
}

/**
 * 운영 키로 시나리오 1~2건을 돌린다. 하루 칸을 먼저 예약하고(실패해도 쓴 것으로 셈) 동시에 부른다.
 * 모델이 쓴 글자는 외부 글자로 보고 이스케이프한다.
 */
export async function evalCommand({
  db,
  client,
  scenarios,
  now,
  model = ANALYSIS_MODEL,
  timeoutMs = EVAL_TIMEOUT_MS,
}: {
  db: Client;
  client: ClaudeClient;
  scenarios: readonly Scenario[];
  now: Date;
  model?: string;
  timeoutMs?: number;
}): Promise<string> {
  await prepareDb(db);
  const used = await reserveCommandCall(db, "eval", now, EVAL_DAILY_LIMIT);
  if (used === null) {
    return `오늘 eval ${EVAL_DAILY_LIMIT}회를 모두 썼습니다. 한국 시각 자정에 다시 쓸 수 있습니다. 8건 전체는 로컬에서 \`pnpm eval\`로 돌리세요.`;
  }

  const results = await Promise.all(
    scenarios.map(async (scenario) => {
      const started = Date.now();
      const outcome = await analyzeIncident(client, scenario.input, { model, timeoutMs });
      return { scenario, outcome, ms: Date.now() - started, problems: grade(scenario, outcome) };
    }),
  );
  const passed = results.filter(({ problems }) => problems.length === 0).length;
  const lines = [`*eval* ${escapeSlack(model)} · ${passed}/${results.length} 통과 · 오늘 ${used}/${EVAL_DAILY_LIMIT}회`];
  for (const { scenario, outcome, ms, problems } of results) {
    const head = `• ${problems.length === 0 ? "PASS" : "FAIL"} \`${scenario.id}\` (${(ms / 1000).toFixed(1)}초)`;
    if (outcome.ok) {
      const { suspectedLayer, deployRelated, crossSite, confidence, summary } = outcome.analysis;
      lines.push(`${head} — ${suspectedLayer} · 배포 ${deployRelated} · 교차 ${crossSite} · 신뢰도 ${confidence}`);
      lines.push(`> ${escapeSlack(summary)}`);
    } else {
      lines.push(head);
    }
    for (const problem of problems) lines.push(`  - ${escapeSlack(problem)}`);
  }
  return lines.join("\n");
}

export type CommandEnv = Record<string, string | undefined>;

/** 테스트에서 바꾸는 외부 의존. */
export type CommandDeps = {
  now?: () => Date;
  openDb?: () => Client;
  claude?: (apiKey: string) => ClaudeClient;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * 응답 뒤에 하는 일. 결과 문구를 돌려준다. 같은 요청(서명)을 이미 실행했으면 null이다(재전송·재생).
 * 설정 문제는 DB를 열기 전에 변수 이름만 알려 준다(값은 내보내지 않음).
 * 그 밖의 오류는 던진다(route가 일반 문구로 답하고 이름만 로그에 남긴다).
 */
export async function runOpsCommand(
  command: Exclude<OpsCommand, { kind: "reply" }>,
  env: CommandEnv,
  requestId: string,
  deps: CommandDeps = {},
): Promise<string | null> {
  const now = deps.now ?? (() => new Date());
  let work: (db: Client) => Promise<string>;

  if (command.kind === "eval") {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) return "`ANTHROPIC_API_KEY`가 없어 eval을 돌릴 수 없습니다.";
    const { scenarios } = command;
    const createClient = deps.claude ?? claudeClient;
    work = (db) => evalCommand({ db, client: createClient(apiKey), scenarios, now: now() });
  } else if (command.kind === "status") {
    let targets: Target[];
    try {
      targets = parseTargets(env.OPS_TARGETS);
    } catch (error) {
      if (!(error instanceof TargetsConfigError)) throw error;
      return "환경변수를 확인하세요: `OPS_TARGETS`";
    }
    work = (db) => statusReport(db, targets, now());
  } else {
    let collectEnv: CollectEnv;
    try {
      collectEnv = loadCollectEnv(env);
    } catch (error) {
      if (!(error instanceof EnvError)) throw error;
      return `환경변수를 확인하세요: ${error.keys.map((key) => `\`${key}\``).join(", ")}`;
    }
    work = (db) =>
      collectCommand({ ...collectEnv, db, now: deps.now, fetchImpl: deps.fetchImpl, sleep: deps.sleep });
  }

  const db = (deps.openDb ?? openDb)();
  try {
    await prepareDb(db);
    // 일을 시작하기 전에 예약한다. 겹쳐 온 같은 요청은 한쪽만 실행된다.
    if (!(await claimSlackRequest(db, requestId, now()))) return null;
    return await work(db);
  } finally {
    db.close();
  }
}
