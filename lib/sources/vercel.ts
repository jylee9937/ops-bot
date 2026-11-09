import { z } from "zod";
import { maskLogMessage } from "../mask";
import type { Deploy, Signal, SourceResult } from "../signal";
import type { Target } from "../targets";
import {
  getJson,
  httpsUrl,
  MAX_PAGES,
  nonNegativeInt,
  SourceError,
  windowStart,
  type CollectOptions,
} from "./shared";

export type VercelConfig = { teamId: string; token: string };
export type VercelResult = SourceResult & { deploys: Deploy[] };

const API = "https://api.vercel.com/v7/deployments";
const PAGE_SIZE = 100;
const FALLBACK_LINK = "https://vercel.com/dashboard";
// 빌드가 오래 걸린 배포는 만든 시각이 커서보다 앞서도 나중에 ERROR가 된다.
// 빌드 제한 시간보다 넉넉하게 다시 읽는다.
const DEPLOY_LOOKBACK_MS = 60 * 60_000;

const SHA = /^[0-9a-f]{7,40}$/i;
const ERROR_CODE = /^[A-Z0-9_]{1,60}$/;

// 커밋 메시지·errorMessage·작성자는 자유 텍스트라 읽지 않는다.
const deploymentSchema = z
  .object({
    uid: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
    created: nonNegativeInt,
    ready: nonNegativeInt.nullish(),
    readyState: z.string().min(1).optional(),
    state: z.string().min(1).optional(),
    target: z.string().nullish(),
    errorCode: z.string().nullish(),
    inspectorUrl: httpsUrl.nullish(),
    meta: z.object({ githubCommitSha: z.string().nullish() }).nullish(),
  })
  .transform(({ uid, id, readyState, state, ...rest }, ctx) => {
    // API 문서는 uid·readyState, 다른 경로의 응답은 id·state로 준다.
    const deploymentId = uid ?? id;
    const resolvedState = readyState ?? state;
    if (!deploymentId || !resolvedState) {
      ctx.addIssue({ code: "custom", message: "배포 id 또는 상태가 없습니다" });
      return z.NEVER;
    }
    return { ...rest, deploymentId, state: resolvedState };
  });

const pageSchema = z.object({
  deployments: z.array(z.unknown()),
  pagination: z.object({ next: nonNegativeInt.nullish() }),
});

/**
 * 배포 실패 신호. 폴링과 webhook이 같은 배포를 받아도 incident 하나가 되도록 지문·제목을 한곳에서 만든다.
 * 오류 코드는 폴링 응답에만 있다(webhook 본문에는 없음).
 */
export function deployFailedSignal(
  targetId: string,
  deploy: {
    deploymentId: string;
    errorCode?: string | null;
    link: string | null;
    firstSeen: string;
    lastSeen: string;
  },
): Signal {
  const code = deploy.errorCode && ERROR_CODE.test(deploy.errorCode) ? ` (${deploy.errorCode})` : "";
  return {
    target: targetId,
    source: "vercel",
    kind: "deploy.failed",
    fingerprint: `vercel:${deploy.deploymentId}:ERROR`,
    sourceId: deploy.deploymentId,
    title: maskLogMessage(`배포 실패${code}`),
    tag: null,
    route: null,
    count: 1,
    users: 0,
    firstSeen: deploy.firstSeen,
    lastSeen: deploy.lastSeen,
    link: deploy.link ?? FALLBACK_LINK,
  };
}

/** 커서 이후 production 배포를 읽는다. 타임라인은 모든 상태를, 알림은 ERROR만 쓴다. */
export async function collectVercel(
  targetId: string,
  vercel: Target["vercel"],
  config: VercelConfig,
  { cursor, now, ...request }: CollectOptions,
): Promise<VercelResult> {
  const since = Math.min(
    windowStart(cursor, now).getTime(),
    now.getTime() - DEPLOY_LOOKBACK_MS,
  );
  const signals: Signal[] = [];
  const deploys: Deploy[] = [];
  let skipped = 0;
  let truncated = false;
  let until: number | null = null;

  for (let page = 1; ; page++) {
    const url = new URL(API);
    url.searchParams.set("projectId", vercel.projectId);
    url.searchParams.set("target", "production");
    url.searchParams.set("teamId", config.teamId);
    url.searchParams.set("since", String(since));
    url.searchParams.set("limit", String(PAGE_SIZE));
    if (until !== null) url.searchParams.set("until", String(until));

    const { body } = await getJson("vercel", url, config.token, request);
    const parsedPage = pageSchema.safeParse(body);
    if (!parsedPage.success) throw new SourceError("vercel", "invalid_response");

    for (const item of parsedPage.data.deployments) {
      const parsed = deploymentSchema.safeParse(item);
      if (!parsed.success) {
        skipped++;
        continue;
      }
      if (parsed.data.target !== "production") continue;

      const { deploymentId, state, created, ready, errorCode, inspectorUrl, meta } = parsed.data;
      const createdAt = new Date(created).toISOString();
      const sha = meta?.githubCommitSha;

      deploys.push({
        target: targetId,
        deploymentId,
        sha: sha && SHA.test(sha) ? sha : null,
        state,
        createdAt,
        readyAt: ready == null ? null : new Date(ready).toISOString(),
      });

      if (state === "ERROR") {
        signals.push(
          deployFailedSignal(targetId, {
            deploymentId,
            errorCode,
            link: inspectorUrl ?? null,
            firstSeen: createdAt,
            lastSeen: new Date(ready ?? created).toISOString(),
          }),
        );
      }
    }

    const { deployments, pagination } = parsedPage.data;
    if (deployments.length < PAGE_SIZE || pagination.next == null) break;
    if (page === MAX_PAGES) {
      truncated = true;
      break;
    }
    until = pagination.next;
  }

  return { signals, deploys, skipped, nextCursor: truncated ? cursor : now.toISOString() };
}
