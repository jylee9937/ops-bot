import { createHash, timingSafeEqual } from "node:crypto";
import { runCollect } from "@/lib/collect";
import { EnvError, loadCollectEnv } from "@/lib/env";
import { openDb } from "@/lib/incidents";

// lib/collect의 실행 예산(90초)보다 길게 둔다.
export const maxDuration = 120;

/** 길이가 달라도 같은 시간이 걸리게 해시끼리 비교한다. */
function sameSecret(received: string | null, expected: string): boolean {
  if (!received) return false;
  const a = createHash("sha256").update(received).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Vercel Cron이 5분마다 부른다(`Authorization: Bearer CRON_SECRET`).
 * 응답에는 처리 건수와 단계별 성공 여부만 담는다. incident 내용은 싣지 않는다.
 */
export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return new Response(null, { status: 500 });
  if (!sameSecret(request.headers.get("authorization"), `Bearer ${secret}`)) {
    return new Response(null, { status: 401 });
  }

  let env;
  try {
    env = loadCollectEnv(process.env);
  } catch (error) {
    if (!(error instanceof EnvError)) throw error;
    console.error(`[collect] ${error.message}`);
    return Response.json({ error: "config", keys: error.keys }, { status: 500 });
  }

  const db = openDb();
  try {
    const result = await runCollect({ ...env, db });
    console.info(
      `[collect] ${result.status} · 단계 ${result.steps.filter((s) => s.ok).length}/${result.steps.length} 성공 · heartbeat ${result.heartbeat}`,
    );
    return Response.json(result);
  } catch (error) {
    console.error("[collect] 실행 실패", error instanceof Error ? error.name : "unknown");
    return Response.json({ error: "internal" }, { status: 500 });
  } finally {
    db.close();
  }
}
