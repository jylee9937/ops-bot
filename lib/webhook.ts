import type { Client } from "@libsql/client";
import type { CollectEnv } from "./env";
import { ingest, prepareDb, type IngestSummary } from "./incidents";
import { deliverPending, type DeliveryResult } from "./report";
import type { Signal } from "./signal";
import { postMessage } from "./slack";
import type { Target } from "./targets";

/**
 * Vercel은 30초 안에 2xx를 기다린다. 요청이 들어온 뒤 15초 안에만 새 Slack 전송·재시도를 시작한다.
 * 마지막 전송이 Slack 제한 10초를 다 써도 25초 안에 끝나고, 완료 기록할 여유가 남는다.
 */
export const WEBHOOK_SEND_WINDOW_MS = 15_000;

export type WebhookDeps = Pick<CollectEnv, "slack"> & {
  db: Client;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  // 요청이 들어온 시각(ms). 예산은 여기서부터 센다. 없으면 이 함수를 부른 시각.
  startedAt?: number;
  // 설정된 모든 사이트. 같은 시각 에러가 난 다른 사이트의 이름을 적는다.
  sites?: readonly Target[];
};

export type WebhookResult = {
  ingested: IngestSummary;
  delivered: Pick<DeliveryResult, "detailed" | "bundled" | "skipped">;
  // Slack 전송 실패·예산 종료면 webhook은 성공으로 끝낸다. incident는 저장됐고 다음 collect가 다시 보낸다.
  // DB 오류는 여기 담지 않고 던진다.
  deliveryError: unknown;
};

/**
 * 배포 실패 webhook: 폴링과 같은 지문으로 incident에 넣고, 그 사이트의 미전송 알림을 바로 보낸다.
 * 폴링이 같은 실패를 나중에 읽어도 같은 incident라 알림은 한 번이다. 동시 실행은 전송 표가 막는다.
 * 배포 목록은 기록하지 않는다. 본문에 배포를 만든 시각이 없어, 폴링이 정확한 시각으로 기록한다.
 */
export async function handleDeployFailure(
  target: Target,
  signal: Signal,
  deps: WebhookDeps,
): Promise<WebhookResult> {
  const { db, slack } = deps;
  const now = (deps.now ?? (() => new Date()))();
  await prepareDb(db);
  const ingested = await ingest(db, target, [signal], now);

  const deadline = (deps.startedAt ?? Date.now()) + WEBHOOK_SEND_WINDOW_MS;
  const delivery = await deliverPending(
    db,
    target,
    now,
    (message) => postMessage(message, slack.token, { fetchImpl: deps.fetchImpl }),
    {
      ownerUserId: slack.ownerUserId,
      sleep: deps.sleep,
      shouldStop: (afterMs = 0) => Date.now() + afterMs >= deadline,
      // Claude는 부르지 않는다. 30초 응답 제한 안에 끝내야 하고, 배포 실패는 요약할 오류 문구가 없다.
      sites: deps.sites,
    },
  );
  return {
    ingested,
    delivered: { detailed: delivery.detailed, bundled: delivery.bundled, skipped: delivery.skipped },
    deliveryError: delivery.error,
  };
}
