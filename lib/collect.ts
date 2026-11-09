import type { Client } from "@libsql/client";
import {
  claudeClient,
  createAnalyzer,
  DAILY_ANALYSIS_LIMIT,
  type AnalysisFailure,
  type ClaudeClient,
} from "./analysis";
import type { CollectEnv } from "./env";
import {
  acquireLock,
  getCursor,
  ingest,
  isDeliveryOverdue,
  listOpenSentryIncidents,
  prepareDb,
  purgeExpired,
  recordDeploys,
  releaseLock,
  reserveAnalysisCall,
  resolveIncident,
  saveCursor,
  type IngestSummary,
} from "./incidents";
import { deliverPending } from "./report";
import { postMessage, SlackError } from "./slack";
import { collectSentry, fetchSentryFrames, fetchSentryIssueStatus } from "./sources/sentry";
import { SourceError, type RequestOptions } from "./sources/shared";
import { collectVercel } from "./sources/vercel";
import type { Target } from "./targets";

export const LOCK_NAME = "collect";
/** 실행 시간 예산. route의 maxDuration(120초)과 잠금 TTL(5분)보다 짧다. */
export const RUN_BUDGET_MS = 90_000;
/** 실행마다 사이트당 Sentry 해결 여부를 확인할 열린 incident 수. 실행마다 돌아가며 고른다. */
export const STATUS_CHECK_LIMIT = 10;
// 열린 incident가 이보다 많으면 넘는 몫은 확인하지 않는다(지금 규모에서는 닿지 않는 값).
const MAX_OPEN_SCAN = 500;
const SENTRY_ISSUE_ID = /^\d{1,20}$/;
const MIGRATION_ATTEMPTS = 3;
const CRON_INTERVAL_MS = 5 * 60_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
// 스택은 보조 정보다. 늦으면 스택 없이 보낸다.
const FRAMES_TIMEOUT_MS = 5_000;

export type Step = "vercel" | "sentry" | "sentry-status" | "slack";
/**
 * 수집 단계는 받아들인 항목 수(`received`, Sentry는 에러 issue만)와 형식이 달라 건너뛴 수를 함께 남긴다.
 * 건너뛴 항목이 있으면 그 단계는 실패로 보고 커서도 옮기지 않는다. 외부 응답 형식이 바뀌어
 * 전부 걸러져도 조용히 지나가지 않고, 고칠 때까지 heartbeat가 멈춘다.
 */
export type StepResult = {
  target: string;
  step: Step;
  ok: boolean;
  reason?: string;
  received?: number;
  skipped?: number;
};
type Counts = { received: number; skipped: number };

export type CollectResult = {
  status: "done" | "locked";
  steps: StepResult[];
  ingested: IngestSummary;
  delivered: { detailed: number; bundled: number; skipped: number; analyzed: number; analysisFailed: number };
  heartbeat: "sent" | "skipped" | "failed" | "disabled";
};

export type CollectDeps = CollectEnv & {
  db: Client;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  // 테스트에서 Slack 전송 간격을 기다리지 않게 바꾼다.
  sleep?: (ms: number) => Promise<void>;
  budgetMs?: number;
  holder?: string;
  // 테스트에서 Claude API 대신 쓴다. 키가 있을 때만 부른다.
  claude?: ClaudeClient;
};

/** 오류를 고정된 이유 문자열로 줄인다. 메시지·URL·토큰은 밖으로 내보내지 않는다. */
export function reasonOf(error: unknown): string {
  if (error instanceof SourceError || error instanceof SlackError) return error.reason;
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  return "internal";
}

function emptySummary(): IngestSummary {
  return { created: 0, updated: 0, reopened: 0, escalated: 0, resolved: 0, ignored: 0 };
}

function addSummary(total: IngestSummary, part: IngestSummary): void {
  for (const key of Object.keys(total) as (keyof IngestSummary)[]) total[key] += part[key];
}

/**
 * 열린 incident 목록을 실행마다 limit만큼 밀린 위치부터 자른다.
 * 1칸씩 밀면 limit보다 많을 때 다 도는 데 오래 걸린다. limit씩 밀면 ceil(n/limit)번이면 다 확인된다.
 */
export function rotate<T>(items: readonly T[], now: Date, limit: number): T[] {
  if (items.length <= limit) return [...items];
  const start = (Math.floor(now.getTime() / CRON_INTERVAL_MS) * limit) % items.length;
  return [...items.slice(start), ...items.slice(0, start)].slice(0, limit);
}

/**
 * 5분마다 한 번: 잠금 → 사이트마다 Vercel 배포 기록·배포 실패 → Sentry issue → Sentry 해결 확인
 * → Slack 전송 → 보관 기간 정리 → heartbeat → 잠금 해제.
 * 출처 하나가 실패해도 나머지는 계속한다. 실패한 출처는 커서를 옮기지 않아 다음 실행이 다시 읽는다.
 * heartbeat는 모든 수집 단계가 성공하고 15분 넘게 못 보낸 알림이 없을 때만 보낸다(D21).
 */
export async function runCollect(deps: CollectDeps): Promise<CollectResult> {
  const { db, targets, sentry, vercel, slack, heartbeatUrl } = deps;
  const clock = deps.now ?? (() => new Date());
  const now = clock();
  const budgetMs = deps.budgetMs ?? RUN_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  const signal = AbortSignal.timeout(budgetMs);
  const request: RequestOptions = { fetchImpl: deps.fetchImpl, signal };
  const result: CollectResult = {
    status: "done",
    steps: [],
    ingested: emptySummary(),
    delivered: { detailed: 0, bundled: 0, skipped: 0, analyzed: 0, analysisFailed: 0 },
    heartbeat: "skipped",
  };

  // 잠금 표도 마이그레이션이 만든다. 잠금보다 먼저 적용한다.
  // 처음 실행이 겹치면 한쪽이 '이미 있음'으로 실패한다. 다시 보면 적용된 버전은 건너뛴다.
  for (let attempt = 1; ; attempt++) {
    try {
      await prepareDb(db);
      break;
    } catch (error) {
      if (attempt >= MIGRATION_ATTEMPTS) throw error;
    }
  }
  const holder = deps.holder ?? crypto.randomUUID();
  if (!(await acquireLock(db, LOCK_NAME, holder, now))) return { ...result, status: "locked" };

  /** 단계를 실행하고 결과를 남긴다. 돌려주는 값은 요청 자체가 성공했는지다(건너뛴 항목과 무관). */
  const run = async (target: Target, step: Step, work: () => Promise<Counts | void>) => {
    try {
      const counts = await work();
      const entry: StepResult = { target: target.id, step, ok: true, ...(counts ?? {}) };
      if (counts && counts.skipped > 0) {
        entry.ok = false;
        entry.reason = "invalid_items";
        console.error(`[collect] ${target.id} ${step}: 형식이 다른 항목 ${counts.skipped}건을 건너뜀`);
      }
      result.steps.push(entry);
      return true;
    } catch (error) {
      const reason = reasonOf(error);
      console.error(`[collect] ${target.id} ${step} 실패: ${reason}`);
      result.steps.push({ target: target.id, step, ok: false, reason });
      return false;
    }
  };

  try {
    for (const target of targets) {
      // 배포를 먼저 기록해야 Sentry incident의 '배포 직후'를 판단할 수 있다.
      await run(target, "vercel", async () => {
        const cursor = await getCursor(db, target.id, "vercel");
        const collected = await collectVercel(target.id, target.vercel, vercel, { cursor, now, ...request });
        await recordDeploys(db, collected.deploys, now);
        addSummary(result.ingested, await ingest(db, target, collected.signals, now));
        if (collected.nextCursor && collected.skipped === 0) {
          await saveCursor(db, target.id, "vercel", collected.nextCursor, now);
        }
        return { received: collected.deploys.length, skipped: collected.skipped };
      });

      if (target.sentry && sentry) {
        const sentryTarget = target.sentry;
        const collectedOk = await run(target, "sentry", async () => {
          const cursor = await getCursor(db, target.id, "sentry");
          const collected = await collectSentry(target.id, sentryTarget, sentry, { cursor, now, ...request });
          addSummary(result.ingested, await ingest(db, target, collected.signals, now));
          if (collected.nextCursor && collected.skipped === 0) {
            await saveCursor(db, target.id, "sentry", collected.nextCursor, now);
          }
          return { received: collected.signals.length, skipped: collected.skipped };
        });

        // 목록 요청이 성공해 토큰이 이 사이트를 읽을 수 있을 때만 확인한다.
        // 권한 문제로 404가 나면 전부 해결로 잘못 닫힌다. 건너뛴 항목이 있어도 요청은 성공한 것이다.
        if (collectedOk) {
          await run(target, "sentry-status", async () => {
            const open = await listOpenSentryIncidents(db, target.id, MAX_OPEN_SCAN);
            // 수집기가 만든 id는 숫자다. 다르면 경로가 바뀌어 404로 잘못 닫힐 수 있어 건너뛴다.
            const checkable = open.filter((incident) => SENTRY_ISSUE_ID.test(incident.evidence.sourceId));
            for (const incident of rotate(checkable, now, STATUS_CHECK_LIMIT)) {
              const status = await fetchSentryIssueStatus(sentry, incident.evidence.sourceId, request);
              if (status !== "resolved" && status !== "ignored" && status !== "missing") continue;
              if (await resolveIncident(db, target.id, incident.fingerprint, now, incident.episode)) {
                result.ingested.resolved++;
              }
            }
          });
        }
      }
    }

    // 실행당·하루 상한을 넘으면 템플릿으로 보낸다(D9). 실행당 상한은 두 사이트가 함께 쓴다.
    const apiKey = deps.anthropicApiKey;
    const analyzer = apiKey
      ? createAnalyzer({
          client: deps.claude ?? claudeClient(apiKey),
          // 실행 시작 시각이 아니라 부르는 순간의 날짜로 센다. 자정을 넘긴 실행이 전날 칸을 쓰지 않게.
          reserveDaily: () => reserveAnalysisCall(db, clock(), DAILY_ANALYSIS_LIMIT),
        })
      : undefined;

    // 모든 사이트를 수집한 뒤 보낸다. Slack 간격·재시도 대기가 뒤 사이트의 수집 예산을 먹지 않게 한다.
    // 보내는 중인 전송에는 실행 예산의 끊기 신호를 걸지 않고(자체 10초 제한만), 새 전송 전에만 예산을 본다.
    for (const target of targets) {
      const sentryTarget = target.sentry;
      await run(target, "slack", async () => {
        const delivery = await deliverPending(
          db,
          target,
          now,
          (message) => postMessage(message, slack.token, { fetchImpl: deps.fetchImpl }),
          {
            ownerUserId: slack.ownerUserId,
            sleep: deps.sleep,
            shouldStop: (afterMs = 0) => Date.now() + afterMs >= deadline,
            analyzer,
            sites: targets,
            frames:
              sentryTarget && sentry
                ? async (incident) =>
                    // 해결 확인과 같은 이유로 수집기가 만든 숫자 id만 경로에 넣는다.
                    SENTRY_ISSUE_ID.test(incident.evidence.sourceId)
                      ? fetchSentryFrames(sentryTarget, sentry, incident.evidence.sourceId, {
                          fetchImpl: deps.fetchImpl,
                          signal: AbortSignal.timeout(FRAMES_TIMEOUT_MS),
                        })
                      : []
                : undefined,
          },
        );
        result.delivered.detailed += delivery.detailed;
        result.delivered.bundled += delivery.bundled;
        result.delivered.skipped += delivery.skipped;
        result.delivered.analyzed += delivery.analyzed;
        result.delivered.analysisFailed += delivery.analysisFailures.length;
        if (delivery.analysisFailures.length > 0) {
          console.error(`[collect] ${target.id} 요약 없이 보냄: ${countReasons(delivery.analysisFailures)}`);
        }
        if (delivery.error) throw delivery.error;
      });
    }

    await purgeExpired(db, now);

    // Slack 실패는 바로 heartbeat를 막지 않는다. 못 보낸 알림이 15분 넘게 쌓이면 막는다.
    const collectedAll = result.steps.filter(({ step }) => step !== "slack").every(({ ok }) => ok);
    if (!heartbeatUrl) {
      result.heartbeat = "disabled";
    } else if (!collectedAll || (await isDeliveryOverdue(db, now, targets.map(({ id }) => id)))) {
      result.heartbeat = "skipped";
    } else {
      result.heartbeat = await ping(heartbeatUrl, deps.fetchImpl);
    }
  } finally {
    await releaseLock(db, LOCK_NAME, holder);
  }
  return result;
}

/** 실패 이유를 `timeout×2, daily_limit×1`처럼 센다. 내용은 담지 않는다. */
function countReasons(reasons: readonly AnalysisFailure[]): string {
  const counts = new Map<AnalysisFailure, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts].map(([reason, count]) => `${reason}×${count}`).join(", ");
}

async function ping(url: string, fetchImpl: typeof fetch = fetch): Promise<"sent" | "failed"> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS) });
    return response.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
