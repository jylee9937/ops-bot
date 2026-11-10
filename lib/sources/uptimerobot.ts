import { z } from "zod";
import { maskLogMessage, maskRoute } from "../mask";
import type { Signal } from "../signal";
import { getJson, isoDate, nonNegativeInt, SourceError, type RequestOptions } from "./shared";

/** Read-only 키. 감시를 바꾸거나 지울 수 없다. */
export type UptimeRobotConfig = { apiKey: string };

const API = "https://api.uptimerobot.com/v3/monitors";
const PAGE_SIZE = 50;
// 무료 요금제는 분당 10회다. 실행당 이만큼만 읽는다.
const MAX_PAGES = 4;
const DASHBOARD = "https://dashboard.uptimerobot.com/monitors";
// UptimeRobot이 만드는 사유 문구(예: "404 Not Found")만 받는다.
const REASON = /^[A-Za-z0-9 .()-]{1,60}$/;

// 감시 이름(friendlyName)·헤더·인증 칸은 사용자가 쓴 글이라 읽지 않는다.
const monitorSchema = z.object({
  id: nonNegativeInt,
  url: z.string().min(1).max(2_000),
  status: z.string().min(1).max(40),
  currentStateDuration: nonNegativeInt.nullish(),
  lastIncident: z
    .object({
      status: z.string().max(40).nullish(),
      startedAt: isoDate.nullish(),
      cause: z.union([z.number(), z.string().max(40)]).nullish(),
      reason: z.string().max(200).nullish(),
    })
    .nullish(),
});

const pageSchema = z.object({
  data: z.array(z.unknown()),
  nextLink: z.string().nullish(),
});

export type UptimeMonitor = {
  id: number;
  // 감시 URL의 호스트(소문자). 읽을 수 없으면 null이고 어느 사이트에도 배정되지 않는다.
  host: string | null;
  status: string;
  // 사이트 주소와 쿼리를 뗀 경로
  route: ReturnType<typeof maskRoute>;
  // DOWN일 때만: 다운이 시작된 시각과 사유
  downSince: string | null;
  reason: string | null;
};

export type UptimeList = {
  monitors: UptimeMonitor[];
  skipped: number;
  // 모든 쪽을 읽었는지. 아니면 목록에 없다는 이유로 해결 처리하지 않는다.
  complete: boolean;
};

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

function reasonOf(cause: unknown, reason: string | null | undefined): string | null {
  if (reason && REASON.test(reason)) return reason;
  const code = typeof cause === "string" && /^\d{3}$/.test(cause) ? Number(cause) : cause;
  return typeof code === "number" && Number.isInteger(code) && code >= 100 && code <= 599 ? `HTTP ${code}` : null;
}

/**
 * 다운 시작 시각. 진행 중인 마지막 incident의 `startedAt`이 고정값이라 이것을 쓴다.
 * 없으면 지금 상태가 이어진 시간(초)으로 거꾸로 계산한다(호출마다 1초쯤 흔들린다 — incidents가 1분 안이면 같은 다운으로 본다).
 * 둘 다 없으면 null이다. 매번 실행 시각을 시작으로 삼으면 같은 다운이 새 다운이 된다.
 */
function downSinceOf(monitor: z.infer<typeof monitorSchema>, now: Date): string | null {
  const incident = monitor.lastIncident;
  const ongoing = !incident?.status || incident.status.toLowerCase() === "ongoing";
  if (incident?.startedAt && ongoing) return incident.startedAt;
  if (monitor.currentStateDuration == null) return null;
  const seconds = monitor.currentStateDuration;
  return new Date(Math.floor((now.getTime() - seconds * 1000) / 1000) * 1000).toISOString();
}

/** 다운인데 시작 시각을 알 수 없으면 null(형식이 다른 항목으로 센다). */
function toMonitor(raw: z.infer<typeof monitorSchema>, now: Date): UptimeMonitor | null {
  const down = raw.status === "DOWN";
  const downSince = down ? downSinceOf(raw, now) : null;
  if (down && downSince === null) return null;
  return {
    id: raw.id,
    host: hostOf(raw.url),
    status: raw.status,
    route: maskRoute(raw.url),
    downSince,
    reason: down ? reasonOf(raw.lastIncident?.cause, raw.lastIncident?.reason) : null,
  };
}

/** 계정의 감시 목록을 읽는다. 실행당 한 번만 부르고 사이트별로 나눈다. */
export async function fetchUptimeMonitors(
  config: UptimeRobotConfig,
  { now, ...request }: RequestOptions & { now: Date },
): Promise<UptimeList> {
  const monitors: UptimeMonitor[] = [];
  let skipped = 0;
  let url: URL | null = new URL(`${API}?limit=${PAGE_SIZE}`);

  for (let page = 0; url && page < MAX_PAGES; page++) {
    const { body } = await getJson("uptimerobot", url, config.apiKey, request);
    const parsed = pageSchema.safeParse(body);
    if (!parsed.success) throw new SourceError("uptimerobot", "invalid_response");

    for (const item of parsed.data.data) {
      const raw = monitorSchema.safeParse(item);
      const monitor = raw.success ? toMonitor(raw.data, now) : null;
      if (monitor) monitors.push(monitor);
      else skipped++;
    }

    url = nextPage(parsed.data.nextLink);
  }

  return { monitors, skipped, complete: url === null };
}

// 다음 쪽 주소는 같은 API의 감시 목록일 때만 따라간다. 토큰을 다른 곳으로 보내지 않는다.
function nextPage(link: string | null | undefined): URL | null {
  if (!link) return null;
  try {
    const url = new URL(link);
    if (url.origin !== new URL(API).origin || url.pathname !== new URL(API).pathname) {
      throw new SourceError("uptimerobot", "invalid_response");
    }
    return url;
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError("uptimerobot", "invalid_response");
  }
}

/** 이 사이트 호스트의 감시만 고른다. 호스트가 정확히 같아야 한다. */
export function monitorsFor(hosts: readonly string[], monitors: readonly UptimeMonitor[]): UptimeMonitor[] {
  return monitors.filter((monitor) => monitor.host !== null && hosts.includes(monitor.host));
}

/** DOWN인 감시 하나가 incident 하나다. 같은 다운은 시작 시각이 같아 다시 열리지 않는다. */
export function uptimeSignals(targetId: string, monitors: readonly UptimeMonitor[]): Signal[] {
  return monitors.flatMap((monitor) => {
    if (monitor.status !== "DOWN" || !monitor.downSince) return [];
    const suffix = monitor.reason ? ` (${monitor.reason})` : "";
    return [
      {
        target: targetId,
        source: "uptimerobot",
        kind: "uptime.down",
        fingerprint: `uptime:${monitor.id}`,
        sourceId: String(monitor.id),
        title: maskLogMessage(`외부 감시 다운${suffix}`),
        tag: null,
        route: monitor.route,
        count: 1,
        users: 0,
        firstSeen: monitor.downSince,
        lastSeen: monitor.downSince,
        link: `${DASHBOARD}/${monitor.id}`,
      } satisfies Signal,
    ];
  });
}

/**
 * 열린 incident를 닫아도 되는지. 감시가 다시 UP이거나 멈췄으면 닫는다.
 * 목록에 없으면(지웠거나 다른 호스트로 바꿈) 목록을 빠짐없이 읽었을 때만 닫는다.
 * 다 못 읽었거나 형식이 달라 건너뛴 항목이 있으면, 없는 것이 삭제인지 건너뛴 것인지 알 수 없다.
 * 준비 중(`STARTED`) 같은 그 밖의 상태는 그대로 둔다.
 */
export function isRecovered(monitor: UptimeMonitor | undefined, list: Pick<UptimeList, "complete" | "skipped">): boolean {
  if (!monitor) return list.complete && list.skipped === 0;
  return monitor.status === "UP" || monitor.status === "PAUSED";
}
