import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Signal } from "../signal";
import type { Target } from "../targets";
import { httpsUrl, nonNegativeInt } from "./shared";
import { deployFailedSignal } from "./vercel";

// Vercel 이벤트 본문은 수 KB다. 서명 계산 전에 큰 본문을 거른다.
export const MAX_WEBHOOK_BYTES = 256 * 1024;
// Vercel은 2xx를 받지 못하면 24시간 동안 다시 보낸다. 그보다 오래된 이벤트는 재전송으로 보고 무시한다.
const MAX_EVENT_AGE_MS = 25 * 60 * 60_000;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const SIGNATURE = /^[0-9a-f]{40}$/i;
const DEPLOYMENT_ID = /^[A-Za-z0-9_]{1,80}$/;

/**
 * `x-vercel-signature`는 원문 본문의 HMAC-SHA1(16진수)이다. 본문은 파싱하기 전 원문 그대로 넘긴다.
 * Slack과 달리 시각이 서명에 없다. 옛 요청을 다시 보내도 본문 안의 발생 시각이 그대로라
 * 해결한 incident를 다시 열지 못한다(incidents의 '해결 전 발생은 건너뜀' 규칙).
 */
export function verifyVercelSignature(secret: string, body: string, signature: string | null): boolean {
  if (!secret || !signature || !SIGNATURE.test(signature)) return false;
  const expected = Buffer.from(createHmac("sha1", secret).update(body).digest("hex"));
  const received = Buffer.from(signature.toLowerCase());
  return received.length === expected.length && timingSafeEqual(received, expected);
}

const eventSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  createdAt: nonNegativeInt,
  payload: z.unknown(),
});

const deploymentErrorSchema = z.object({
  deployment: z.object({ id: z.string().regex(DEPLOYMENT_ID) }),
  links: z.object({ deployment: httpsUrl.nullish() }).nullish(),
  target: z.string().nullish(),
  project: z.object({ id: z.string().min(1) }),
});

export type VercelWebhookResult =
  | { kind: "ignore"; reason: "event" | "stale" | "target" | "project" }
  | { kind: "invalid" }
  | { kind: "deploy_failed"; target: Target; signal: Signal };

/**
 * 서명을 확인한 본문에서 운영 배포 실패만 꺼낸다. 다른 이벤트·Preview·설정에 없는 프로젝트는 무시한다.
 * 형식이 다르면 invalid(400)를 돌려 Vercel이 다시 보내게 하고 로그에 남긴다. 폴링이 5분 안에 같은 실패를 잡는다.
 */
export function parseVercelWebhook(
  body: string,
  targets: readonly Target[],
  now: Date,
): VercelWebhookResult {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { kind: "invalid" };
  }
  const event = eventSchema.safeParse(json);
  if (!event.success) return { kind: "invalid" };

  const { type, createdAt, payload } = event.data;
  if (type !== "deployment.error") return { kind: "ignore", reason: "event" };
  const age = now.getTime() - createdAt;
  if (age > MAX_EVENT_AGE_MS || age < -MAX_FUTURE_SKEW_MS) return { kind: "ignore", reason: "stale" };

  const parsed = deploymentErrorSchema.safeParse(payload);
  if (!parsed.success) return { kind: "invalid" };
  const { deployment, links, target: environment, project } = parsed.data;
  if (environment !== "production") return { kind: "ignore", reason: "target" };

  const target = targets.find(({ vercel }) => vercel.projectId === project.id);
  if (!target) return { kind: "ignore", reason: "project" };

  const at = new Date(createdAt).toISOString();
  return {
    kind: "deploy_failed",
    target,
    signal: deployFailedSignal(target.id, {
      deploymentId: deployment.id,
      link: links?.deployment ?? null,
      firstSeen: at,
      lastSeen: at,
    }),
  };
}
