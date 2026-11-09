import type { Signal } from "./signal";
import type { Severity, Target } from "./targets";

/** 버킷 시작 시각 → 그 버킷에서 마지막으로 본 누적 횟수 */
export type CountSnapshots = Record<string, number>;

const BUCKET_MS = 5 * 60_000;
const ESCALATION_WINDOW_MS = 10 * 60_000;
const ESCALATION_COUNT = 3;
export const ESCALATION_USERS = 10;

const DEPLOY_AREA = { area: "전체", severity: "P1" } satisfies Classification;
const UNMATCHED_AREA = { area: "기타", severity: "P3" } satisfies Classification;

export type Classification = { area: string; severity: Severity };

function matchesTag(tag: string, pattern: string): boolean {
  return tag === pattern || tag.startsWith(`${pattern}/`);
}

// `/api/play`가 `/api/playback`에, `article`이 `articles`에 걸리지 않게 경계를 본다.
function matchesRoute(route: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const before = /^[A-Za-z0-9_-]/.test(pattern) ? "(?<![A-Za-z0-9_-])" : "";
  return new RegExp(`${before}${escaped}(?![A-Za-z0-9_-])`).test(route);
}

/** 신호를 영역과 기본 등급으로 나눈다. 설정의 앞쪽 영역이 먼저다. */
export function classify(target: Target, signal: Signal): Classification {
  if (signal.kind === "deploy.failed") return DEPLOY_AREA;

  const { tag, route } = signal;
  const area = target.areas.find(({ match }) =>
    match.some(
      (pattern) =>
        (tag !== null && matchesTag(tag, pattern)) ||
        (route !== null && matchesRoute(route, pattern)),
    ),
  );
  return area ? { area: area.name, severity: area.severity } : UNMATCHED_AREA;
}

// P1이 가장 높다.
export function isHigher(a: Severity, b: Severity): boolean {
  return a < b;
}

export function higherOf(a: Severity, b: Severity): Severity {
  return isHigher(a, b) ? a : b;
}

/** 10분 안에 3회 이상이거나 영향 사용자가 기준을 넘으면 한 단계 올린다. 한 번에 한 단계만 오른다. */
export function escalate(base: Severity, increase: number, users: number): Severity {
  if (increase < ESCALATION_COUNT && users < ESCALATION_USERS) return base;
  return base === "P3" ? "P2" : "P1";
}

function bucketOf(time: number): number {
  return time - (time % BUCKET_MS);
}

/**
 * 처음 본 issue의 기준값. Sentry count는 누적값이라 증가분을 바로 알 수 없다.
 * 방금 생긴 issue만 0부터 세고, 오래된 issue는 지금 값을 기준으로 삼는다.
 */
export function initialBaseline(count: number, firstSeen: string, now: Date): number {
  return now.getTime() - Date.parse(firstSeen) <= ESCALATION_WINDOW_MS ? 0 : count;
}

/** 증가분을 잴 기준값을 10분 전 버킷에 둔다. */
export function baselineSnapshots(baseline: number, now: Date): CountSnapshots {
  const start = bucketOf(now.getTime()) - ESCALATION_WINDOW_MS;
  return { [new Date(start).toISOString()]: baseline };
}

/**
 * 누적값을 지금 버킷에 덮어쓰고 최근 10분 증가분을 돌려준다.
 * 같은 버킷을 다시 읽어도 덮어쓰기라 두 번 더해지지 않는다.
 */
export function updateSnapshots(
  snapshots: CountSnapshots,
  count: number,
  now: Date,
): { snapshots: CountSnapshots; increase: number } {
  const bucket = bucketOf(now.getTime());
  const cutoff = bucket - ESCALATION_WINDOW_MS;
  const key = new Date(bucket).toISOString();
  // 누적값은 줄지 않는다. 늦게 도착한 옛 값이 더 큰 값을 덮어쓰지 않게 한다.
  const entries = Object.entries({
    ...snapshots,
    [key]: Math.max(snapshots[key] ?? 0, count),
  }).sort(([a], [b]) => Date.parse(a) - Date.parse(b));

  const baselineIndex = entries.findLastIndex(([key]) => Date.parse(key) <= cutoff);
  const kept = Object.fromEntries(entries.slice(Math.max(baselineIndex, 0)));
  return { snapshots: kept, increase: windowIncrease(kept) };
}

/** 저장된 버킷의 첫 값과 마지막 값 차이. 알림 제목의 '×N (10분)'에 쓴다. */
export function windowIncrease(snapshots: CountSnapshots): number {
  const values = Object.entries(snapshots)
    .sort(([a], [b]) => Date.parse(a) - Date.parse(b))
    .map(([, value]) => value);
  if (values.length === 0) return 0;
  return Math.max(0, values[values.length - 1] - values[0]);
}
