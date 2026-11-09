import type { Client } from "@libsql/client";
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
  resolveIncident,
  saveCursor,
  type IngestSummary,
} from "./incidents";
import { deliverPending } from "./report";
import { postMessage, SlackError } from "./slack";
import { collectSentry, fetchSentryIssueStatus } from "./sources/sentry";
import { SourceError, type RequestOptions } from "./sources/shared";
import { collectVercel } from "./sources/vercel";
import type { Target } from "./targets";

export const LOCK_NAME = "collect";
/** 실행 시간 예산. route의 maxDuration(120초)과 잠금 TTL(5분)보다 짧다. */
export const RUN_BUDGET_MS = 90_000;
/** 실행마다 사이트당 Sentry 해결 여부를 확인할 열린 incident 수. 실행마다 돌아가며 고른다. */
export const STATUS_CHECK_LIMIT = 10;
const MAX_OPEN_SCAN = 500;
const CRON_INTERVAL_MS = 5 * 60_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

export type Step = "vercel" | "sentry" | "sentry-status" | "slack";
/**
 * 수집 단계는 받은 항목 수와 형식이 달라 건너뛴 수를 함께 남긴다.
 * 건너뛴 항목이 있으면 그 단계는 실패로 본다. 외부 응답 형식이 바뀌어 전부 걸러져도 조용히 지나가지 않게 한다.
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
  delivered: { detailed: number; bundled: number; skipped: number };
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
  const now = (deps.now ?? (() => new Date()))();
  const signal = AbortSignal.timeout(deps.budgetMs ?? RUN_BUDGET_MS);
  const request: RequestOptions = { fetchImpl: deps.fetchImpl, signal };
  const result: CollectResult = {
    status: "done",
    steps: [],
    ingested: emptySummary(),
    delivered: { detailed: 0, bundled: 0, skipped: 0 },
    heartbeat: "skipped",
  };

  // 잠금 표도 마이그레이션이 만든다. 잠금보다 먼저 적용한다.
  await prepareDb(db);
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
        if (collected.nextCursor) await saveCursor(db, target.id, "vercel", collected.nextCursor, now);
        return { received: collected.deploys.length, skipped: collected.skipped };
      });

      if (target.sentry && sentry) {
        const sentryTarget = target.sentry;
        const collectedOk = await run(target, "sentry", async () => {
          const cursor = await getCursor(db, target.id, "sentry");
          const collected = await collectSentry(target.id, sentryTarget, sentry, { cursor, now, ...request });
          addSummary(result.ingested, await ingest(db, target, collected.signals, now));
          if (collected.nextCursor) await saveCursor(db, target.id, "sentry", collected.nextCursor, now);
          return { received: collected.signals.length, skipped: collected.skipped };
        });

        // 목록 요청이 성공해 토큰이 이 사이트를 읽을 수 있을 때만 확인한다.
        // 권한 문제로 404가 나면 전부 해결로 잘못 닫힌다. 건너뛴 항목이 있어도 요청은 성공한 것이다.
        if (collectedOk) {
          await run(target, "sentry-status", async () => {
            const open = await listOpenSentryIncidents(db, target.id, MAX_OPEN_SCAN);
            for (const incident of rotate(open, now, STATUS_CHECK_LIMIT)) {
              const status = await fetchSentryIssueStatus(sentry, incident.evidence.sourceId, request);
              if (status !== "resolved" && status !== "ignored" && status !== "missing") continue;
              if (await resolveIncident(db, target.id, incident.fingerprint, now, incident.episode)) {
                result.ingested.resolved++;
              }
            }
          });
        }
      }

      await run(target, "slack", async () => {
        const delivery = await deliverPending(
          db,
          target,
          now,
          (message) => postMessage(message, slack.token, request),
          { ownerUserId: slack.ownerUserId, sleep: deps.sleep },
        );
        result.delivered.detailed += delivery.detailed;
        result.delivered.bundled += delivery.bundled;
        result.delivered.skipped += delivery.skipped;
        if (delivery.error) throw delivery.error;
      });
    }

    await purgeExpired(db, now);

    // Slack 실패는 바로 heartbeat를 막지 않는다. 못 보낸 알림이 15분 넘게 쌓이면 막는다.
    const collectedAll = result.steps.filter(({ step }) => step !== "slack").every(({ ok }) => ok);
    if (!heartbeatUrl) {
      result.heartbeat = "disabled";
    } else if (!collectedAll || (await isDeliveryOverdue(db, now))) {
      result.heartbeat = "skipped";
    } else {
      result.heartbeat = await ping(heartbeatUrl, deps.fetchImpl);
    }
  } finally {
    await releaseLock(db, LOCK_NAME, holder);
  }
  return result;
}

async function ping(url: string, fetchImpl: typeof fetch = fetch): Promise<"sent" | "failed"> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS) });
    return response.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
