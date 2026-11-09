import { z } from "zod";
import {
  maskException,
  maskFrame,
  maskLogMessage,
  maskRoute,
  tagOf,
  type MaskedFrame,
} from "../mask";
import type { Signal, SignalKind, SourceResult } from "../signal";
import type { Target } from "../targets";
import {
  getJson,
  httpsUrl,
  isoDate,
  MAX_PAGES,
  nonNegativeInt,
  SourceError,
  windowStart,
  type CollectOptions,
  type RequestOptions,
} from "./shared";

export type SentryConfig = { org: string; token: string };
export type SentryIssueStatus = "unresolved" | "resolved" | "ignored" | "missing" | "other";

const API = "https://sentry.io/api/0/organizations";
const PAGE_SIZE = "100";
const MAX_FRAMES = 5;

const issueSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  culprit: z.string().nullish(),
  count: nonNegativeInt,
  userCount: nonNegativeInt.nullish(),
  firstSeen: isoDate,
  lastSeen: isoDate,
  permalink: httpsUrl,
  status: z.string(),
  substatus: z.string().nullish(),
  issueCategory: z.string().nullish(),
  metadata: z
    .object({
      type: z.string().nullish(),
      value: z.string().nullish(),
      title: z.string().nullish(),
    })
    .nullish(),
  // 상위 count·userCount는 조회 기간에 따라 달라질 수 있어 전체 누적값을 먼저 쓴다.
  lifetime: z.object({ count: nonNegativeInt, userCount: nonNegativeInt.nullish() }).nullish(),
});

type Issue = z.infer<typeof issueSchema>;

const frameSchema = z.object({
  filename: z.string().nullish(),
  absPath: z.string().nullish(),
  function: z.string().nullish(),
  lineNo: z.number().nullish(),
  inApp: z.boolean().nullish(),
});

const eventSchema = z.object({
  entries: z.array(z.object({ type: z.string(), data: z.unknown() })),
});

const exceptionSchema = z.object({
  values: z.array(
    z.object({
      stacktrace: z.object({ frames: z.array(frameSchema).nullish() }).nullish(),
    }),
  ),
});

function kindOf(issue: Issue): SignalKind {
  if (issue.status === "resolved") return "issue.resolved";
  if (issue.status === "ignored") return "issue.ignored";
  if (issue.substatus === "regressed") return "issue.regressed";
  if (issue.substatus === "new") return "issue.new";
  return "issue.ongoing";
}

function titleOf(issue: Issue) {
  const type = issue.metadata?.type;
  return type
    ? maskException(type, issue.metadata?.value)
    : maskLogMessage(issue.metadata?.title ?? issue.title);
}

function toSignal(targetId: string, issue: Issue): Signal {
  const title = titleOf(issue);
  return {
    target: targetId,
    source: "sentry",
    kind: kindOf(issue),
    fingerprint: `sentry:${issue.id}`,
    sourceId: issue.id,
    title,
    tag: tagOf(title),
    route: issue.culprit ? maskRoute(issue.culprit) : null,
    count: issue.lifetime?.count ?? issue.count,
    users: issue.lifetime?.userCount ?? issue.userCount ?? 0,
    firstSeen: issue.firstSeen,
    lastSeen: issue.lastSeen,
    link: issue.permalink,
  };
}

function nextPageCursor(link: string | null): string | null {
  const next = link?.match(/rel="next";\s*results="(true|false)";\s*cursor="([^"]+)"/);
  return next?.[1] === "true" ? next[2] : null;
}

/** 커서 이후에 발생한 production issue를 읽는다. 알릴지는 incidents가 정한다. */
export async function collectSentry(
  targetId: string,
  sentry: NonNullable<Target["sentry"]>,
  config: SentryConfig,
  { cursor, now, ...request }: CollectOptions,
): Promise<SourceResult> {
  const since = windowStart(cursor, now).toISOString().replace(/\.\d{3}Z$/, "Z");
  const signals: Signal[] = [];
  let skipped = 0;
  let truncated = false;
  let pageCursor: string | null = null;

  for (let page = 1; ; page++) {
    const url = new URL(`${API}/${encodeURIComponent(config.org)}/issues/`);
    url.searchParams.set("project", sentry.project);
    url.searchParams.set("environment", sentry.environment);
    url.searchParams.set("query", `lastSeen:>${since}`);
    url.searchParams.set("sort", "date");
    url.searchParams.set("limit", PAGE_SIZE);
    // collapse=stats는 쓰지 않는다. 통계와 함께 count·userCount·firstSeen·lastSeen까지 빠진다(T9 E2E에서 확인).
    if (pageCursor) url.searchParams.set("cursor", pageCursor);

    const { body, headers } = await getJson("sentry", url, config.token, request);
    if (!Array.isArray(body)) throw new SourceError("sentry", "invalid_response");

    for (const item of body) {
      const parsed = issueSchema.safeParse(item);
      if (!parsed.success) {
        skipped++;
      } else if ((parsed.data.issueCategory ?? "error") === "error") {
        // 성능·피드백 issue는 장애 알림 대상이 아니다.
        signals.push(toSignal(targetId, parsed.data));
      }
    }

    pageCursor = nextPageCursor(headers.get("link"));
    if (!pageCursor) break;
    if (page === MAX_PAGES) {
      truncated = true;
      break;
    }
  }

  return { signals, skipped, nextCursor: truncated ? cursor : now.toISOString() };
}

/** 최신 이벤트의 파일·함수·줄. 호출 비용이 있어 알림을 보낼 incident에만 쓴다. */
export async function fetchSentryFrames(
  sentry: NonNullable<Target["sentry"]>,
  config: SentryConfig,
  issueId: string,
  request: RequestOptions = {},
): Promise<MaskedFrame[]> {
  const url = new URL(
    `${API}/${encodeURIComponent(config.org)}/issues/${encodeURIComponent(issueId)}/events/latest/`,
  );
  url.searchParams.set("environment", sentry.environment);

  const { body } = await getJson("sentry", url, config.token, request);

  // 프레임은 보조 정보다. 형식이 달라도 알림을 막지 않는다.
  const event = eventSchema.safeParse(body);
  if (!event.success) return [];

  const entry = event.data.entries.find(({ type }) => type === "exception");
  const exception = exceptionSchema.safeParse(entry?.data);
  if (!exception.success) return [];

  // Sentry는 원인 예외를 앞에, 실제로 던져진 예외를 뒤에 둔다. 프레임도 마지막이 호출 지점이다.
  const frames = exception.data.values.findLast((value) => value.stacktrace?.frames?.length)
    ?.stacktrace?.frames;
  if (!frames) return [];

  const inApp = frames.filter((frame) => frame.inApp);
  return (inApp.length > 0 ? inApp : frames)
    .slice(-MAX_FRAMES)
    .reverse()
    .map((frame) =>
      maskFrame({
        filename: frame.filename ?? frame.absPath,
        function: frame.function,
        line: frame.lineNo,
      }),
    );
}

/**
 * issue 하나의 현재 상태. Sentry에서 해결해도 lastSeen은 바뀌지 않아 collectSentry의
 * 조회 구간에 다시 잡히지 않는다. 열려 있는 incident의 자동 해결은 이 값으로 판단한다.
 */
export async function fetchSentryIssueStatus(
  config: SentryConfig,
  issueId: string,
  request: RequestOptions = {},
): Promise<SentryIssueStatus> {
  const url = new URL(
    `${API}/${encodeURIComponent(config.org)}/issues/${encodeURIComponent(issueId)}/`,
  );

  let body: unknown;
  try {
    ({ body } = await getJson("sentry", url, config.token, request));
  } catch (error) {
    if (error instanceof SourceError && error.status === 404) return "missing";
    throw error;
  }

  const parsed = z.object({ status: z.string() }).safeParse(body);
  if (!parsed.success) throw new SourceError("sentry", "invalid_response");

  const { status } = parsed.data;
  return status === "unresolved" || status === "resolved" || status === "ignored"
    ? status
    : "other";
}
