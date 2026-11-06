import { z } from "zod";
import type { SignalSource } from "../signal";

// Vercel cron은 재시도가 없고 간혹 빠진다. 마지막 성공 시각보다 더 앞에서부터 다시 읽는다.
export const OVERLAP_MS = 10 * 60_000;
export const FIRST_RUN_LOOKBACK_MS = 60 * 60_000;
export const MAX_PAGES = 5;
const REQUEST_TIMEOUT_MS = 10_000;

export type SourceErrorReason =
  | "auth"
  | "rate_limit"
  | "server"
  | "bad_request"
  | "network"
  | "invalid_response";

/** 출처 하나의 실패. collect가 격리한다. 메시지에 URL·토큰·응답 본문을 넣지 않는다. */
export class SourceError extends Error {
  override name = "SourceError";

  constructor(
    readonly source: SignalSource,
    readonly reason: SourceErrorReason,
    readonly status?: number,
  ) {
    super(`${source} 수집 실패: ${reason}${status ? ` (${status})` : ""}`);
  }
}

export type RequestOptions = {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

export type CollectOptions = RequestOptions & {
  cursor: string | null;
  now: Date;
};

function reasonFor(status: number): SourceErrorReason {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  return "bad_request";
}

export async function getJson(
  source: SignalSource,
  url: URL,
  token: string,
  { fetchImpl = fetch, signal }: RequestOptions,
): Promise<{ body: unknown; headers: Headers }> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch {
    throw new SourceError(source, "network");
  }

  if (!response.ok) throw new SourceError(source, reasonFor(response.status), response.status);

  try {
    return { body: await response.json(), headers: response.headers };
  } catch {
    throw new SourceError(source, "invalid_response", response.status);
  }
}

/** 이번 실행이 읽기 시작할 시각. 커서가 없거나 깨졌으면 첫 실행으로 본다. */
export function windowStart(cursor: string | null, now: Date): Date {
  const parsed = cursor ? Date.parse(cursor) : Number.NaN;
  const base = Number.isNaN(parsed) ? now.getTime() - FIRST_RUN_LOOKBACK_MS : parsed;
  return new Date(base - OVERLAP_MS);
}

// 문서 예시는 숫자를 문자열로 적고 스키마는 number로 적는다. 둘 다 받는다.
export const nonNegativeInt = z
  .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
  .refine((value) => Number.isSafeInteger(value) && value >= 0);

export const isoDate = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

export const httpsUrl = z.url({ protocol: /^https$/ });
