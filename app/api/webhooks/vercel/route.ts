import { reasonOf } from "@/lib/collect";
import { EnvError, loadCollectEnv } from "@/lib/env";
import { openDb } from "@/lib/incidents";
import {
  MAX_WEBHOOK_BYTES,
  parseVercelWebhook,
  verifyVercelSignature,
} from "@/lib/sources/vercel-webhook";
import { handleDeployFailure } from "@/lib/webhook";

// Vercel은 30초 안에 2xx를 기다리고, 받지 못하면 24시간 동안 다시 보낸다.
export const maxDuration = 30;

/**
 * Vercel 배포 실패 webhook. 서명을 먼저 확인하고, 운영 배포 실패만 incident로 만들어 바로 알린다.
 * DB가 실패하면 500을 돌려 Vercel이 다시 보내게 한다. 응답에는 건수만 담는다.
 */
export async function POST(request: Request): Promise<Response> {
  const secret = process.env.VERCEL_WEBHOOK_SECRET;
  if (!secret) return new Response(null, { status: 500 });

  const body = await request.text();
  if (body.length > MAX_WEBHOOK_BYTES) return new Response(null, { status: 413 });
  if (!verifyVercelSignature(secret, body, request.headers.get("x-vercel-signature"))) {
    return new Response(null, { status: 401 });
  }

  let env;
  try {
    env = loadCollectEnv(process.env);
  } catch (error) {
    if (!(error instanceof EnvError)) throw error;
    console.error(`[webhooks/vercel] ${error.message}`);
    return Response.json({ error: "config", keys: error.keys }, { status: 500 });
  }

  const parsed = parseVercelWebhook(body, env.targets, new Date());
  if (parsed.kind === "invalid") {
    console.error("[webhooks/vercel] 형식이 다른 이벤트");
    return Response.json({ error: "invalid" }, { status: 400 });
  }
  if (parsed.kind === "ignore") {
    console.info(`[webhooks/vercel] 무시: ${parsed.reason}`);
    return Response.json({ status: "ignored", reason: parsed.reason });
  }

  let db: ReturnType<typeof openDb> | undefined;
  try {
    db = openDb();
    const result = await handleDeployFailure(parsed.target, parsed.signal, { db, slack: env.slack });
    const delivery = result.deliveryError ? reasonOf(result.deliveryError) : "ok";
    if (result.deliveryError) console.error(`[webhooks/vercel] ${parsed.target.id} Slack 전송 실패: ${delivery}`);
    console.info(`[webhooks/vercel] ${parsed.target.id} 배포 실패 처리 · 전송 ${result.delivered.detailed}건`);
    return Response.json({
      status: "processed",
      target: parsed.target.id,
      ingested: result.ingested,
      delivered: result.delivered,
      delivery,
    });
  } catch (error) {
    console.error("[webhooks/vercel] 처리 실패", reasonOf(error));
    return Response.json({ error: "internal" }, { status: 500 });
  } finally {
    db?.close();
  }
}
