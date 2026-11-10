import type { Client } from "@libsql/client";
import {
  ANALYSIS_TIMEOUT_MS,
  type Analysis,
  type AnalysisFailure,
  type AnalysisInput,
  type Analyzer,
} from "./analysis";
import {
  claimPending,
  completeNotification,
  completeNotifications,
  findCorrelatedTargets,
  getClaimedIncident,
  getIncident,
  listClaimed,
  muteIncident,
  releaseClaim,
  resolveIncident,
  saveAnalysis,
  type Incident,
  type StoredAnalysis,
} from "./incidents";
import type { MaskedFrame } from "./mask";
import { windowIncrease } from "./rules";
import {
  escapeSlack,
  isSlackUserId,
  LINK_ACTION_ID,
  mrkdwn,
  plainText,
  SlackError,
  type ButtonElement,
  type Interaction,
  type SlackBlock,
  type SlackMessage,
  type SlackResponse,
} from "./slack";
import type { Severity, Target } from "./targets";

/** 실행당 사이트마다 상세 메시지로 보내는 수. 나머지는 묶음 한 건으로 보낸다(D12). */
export const DETAIL_LIMIT = 5;
/** 묶음 메시지에 적는 최대 줄 수. 넘는 건 개수만 적는다. */
export const BUNDLE_LINE_LIMIT = 20;
export const MUTE_SHORT_MS = 60 * 60_000;
// 끝없는 음소거는 재발을 영영 숨긴다. 끝난 뒤 새로 발생하면 다시 알린다.
export const MUTE_LONG_MS = 30 * 24 * 60 * 60_000;
/** 같은 채널에 이어 보낼 때 두는 간격. Slack은 채널당 초당 1건 정도를 허용한다. */
export const SEND_INTERVAL_MS = 1_100;
/** Slack이 알려 준 대기 시간이 이보다 길면 기다리지 않고 다음 실행에 맡긴다. */
export const MAX_RETRY_WAIT_MS = 10_000;
/** Claude 호출을 시작하려면 호출 제한 시간에 더해 이만큼 남아 있어야 한다(상세·묶음 전송 몫). */
export const ANALYSIS_SEND_RESERVE_MS = 15_000;
/** 두 사이트가 함께 쓰는 플랫폼의 상태 페이지. 같은 시각 다른 사이트에도 에러가 있으면 붙인다(D22). */
export const STATUS_PAGES = [
  { name: "Vercel 상태", url: "https://www.vercel-status.com" },
  { name: "Supabase 상태", url: "https://status.supabase.com" },
] as const;

const FAILURE_LABEL: Record<AnalysisFailure, string> = {
  run_limit: "실행당 상한",
  daily_limit: "하루 상한",
  no_time: "실행 시간 부족",
  timeout: "응답 시간 초과",
  refusal: "응답 거절",
  invalid_response: "응답 형식 오류",
  auth: "API 키 확인 필요",
  api_error: "API 오류",
};

const SECTION_LIMIT = 3_000;
const MAX_LINK_LENGTH = 1_000;
const KST_OFFSET_MS = 9 * 60 * 60_000;
const SEVERITY_ORDER: Record<Severity, number> = { P1: 0, P2: 1, P3: 2 };

export type Send = (message: SlackMessage) => Promise<{ ts: string }>;

/** 버튼을 누른 뒤 원래 메시지에 남기는 상태. 버튼은 없앤다. */
export type IncidentState =
  | { kind: "resolved"; at: Date; by: string }
  | { kind: "muted"; until: Date; by: string };

function kst(iso: string | Date): string {
  const date = new Date(new Date(iso).getTime() + KST_OFFSET_MS);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** https 주소만 쓴다. mrkdwn 링크를 끊는 `|`는 인코딩한다. */
function safeLink(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    const href = url.href.replaceAll("|", "%7C");
    return href.length <= MAX_LINK_LENGTH ? href : null;
  } catch {
    return null;
  }
}

function mention(userId: string | undefined): string {
  return isSlackUserId(userId) ? `<@${userId}> ` : "";
}

/** 제목 줄. 외부에서 온 글자(사이트 이름 제외)는 전부 이스케이프한다. */
function headline(target: Target, incident: Incident): string {
  const increase =
    incident.evidence.source === "sentry" ? windowIncrease(incident.evidence.snapshots) : 0;
  const recent = increase > 0 ? ` ×${increase} (10분)` : "";
  return `[${incident.severity}][${escapeSlack(target.name)}] ${escapeSlack(incident.title)}${recent}`;
}

function reason(incident: Incident): string {
  if (incident.evidence.kind === "deploy.failed") return "배포 실패";
  // 이번 회차에 이미 보낸 적이 있다: 등급이 올랐거나 음소거가 끝난 뒤 새로 발생했다.
  if (incident.slackTs !== null) return "다시 알림";
  if (incident.episode > 1) return `재발 (${incident.episode}회차)`;
  return "새 에러";
}

/** 이 회차·등급에서 만든 보조 정보만 쓴다. 그 뒤 등급이 오르거나 다시 열리면 새로 만든다. */
export function analysisKey(incident: Pick<Incident, "episode" | "severity">): string {
  return `${incident.episode}:${incident.severity}`;
}

function currentAnalysis(incident: Incident): StoredAnalysis | null {
  return incident.analysis && incident.analysis.key === analysisKey(incident) ? incident.analysis : null;
}

/** Claude 요약 줄. 모델이 쓴 글자도 외부 글자로 보고 이스케이프한다. */
function analysisLines(analysis: Analysis): string[] {
  const lines = [`>${escapeSlack(analysis.summary)}`, `의심 계층 ${analysis.suspectedLayer} · 신뢰도 ${analysis.confidence}`];
  if (analysis.userImpact) lines.push(`사용자 영향: ${escapeSlack(analysis.userImpact)}`);
  if (analysis.nextChecks.length > 0) {
    lines.push(`먼저 볼 것: ${analysis.nextChecks.map((check, index) => `${index + 1}) ${escapeSlack(check)}`).join(" ")}`);
  }
  return lines;
}

function frameLine(frame: MaskedFrame): string {
  const line = frame.line === null ? "" : `:${frame.line}`;
  const fn = frame.function ? ` (${escapeSlack(frame.function)})` : "";
  return `위치 ${escapeSlack(frame.filename)}${line}${fn}`;
}

function correlatedLine(ids: readonly string[], sites: readonly Target[]): string | null {
  // 설정에서 빠진 사이트는 이름을 모르므로 적지 않는다.
  const names = ids.flatMap((id) => sites.find((site) => site.id === id)?.name ?? []);
  if (names.length === 0) return null;
  const pages = STATUS_PAGES.map(({ name, url }) => `<${url}|${name}>`).join(" · ");
  return `같은 시각 다른 사이트도 에러: ${names.map(escapeSlack).join(", ")} · 플랫폼 문제일 수 있음 (${pages})`;
}

/**
 * 본문 줄. 버튼을 누른 뒤 다시 그릴 때(`withReason: false`)는 알림 이유를 뺀다.
 * 그때는 이미 보낸 incident라 '다시 알림'으로 잘못 바뀌고, 어느 알림의 버튼인지도 알 수 없다.
 */
function details(incident: Incident, withReason: boolean, sites: readonly Target[]): string[] {
  const { evidence } = incident;
  const area = `영역 ${escapeSlack(incident.area)}`;
  const lines = [withReason ? `${reason(incident)} · ${area}` : area];
  if (evidence.source === "sentry") {
    lines.push(`누적 ${evidence.count}회 · 영향 사용자 ${evidence.users}명`);
  }
  lines.push(`처음 ${kst(incident.firstSeen)} · 마지막 ${kst(incident.lastSeen)} (KST)`);
  if (evidence.route) lines.push(`경로 ${escapeSlack(evidence.route)}`);
  const extra = currentAnalysis(incident);
  // 호출 지점(가장 안쪽 프레임)만 적는다. 나머지는 Sentry에서 본다.
  if (extra && extra.frames.length > 0) lines.push(frameLine(extra.frames[0]));
  if (evidence.relatedDeploy) {
    const { sha, deploymentId, readyAt, createdAt } = evidence.relatedDeploy;
    const name = sha ? sha.slice(0, 7) : deploymentId;
    lines.push(`배포 직후: ${kst(readyAt ?? createdAt)}에 공개된 배포 ${escapeSlack(name)}`);
  }
  const correlated = extra ? correlatedLine(extra.correlated, sites) : null;
  if (correlated) lines.push(correlated);
  return lines;
}

function buttons(incident: Incident): ButtonElement[] {
  const value = `${incident.id}:${incident.episode}`;
  const link = safeLink(incident.evidence.link);
  const open: ButtonElement[] = link
    ? [
        {
          type: "button",
          action_id: LINK_ACTION_ID,
          text: plainText(incident.evidence.source === "vercel" ? "Vercel에서 보기" : "Sentry에서 보기"),
          url: link,
        },
      ]
    : [];
  return [
    ...open,
    { type: "button", action_id: "resolve", text: plainText("해결됨"), value, style: "primary" },
    { type: "button", action_id: "mute_1h", text: plainText("1시간 음소거"), value },
    { type: "button", action_id: "mute_30d", text: plainText("30일 음소거"), value },
  ];
}

function stateSummary(state: IncidentState): string {
  return state.kind === "resolved" ? `해결 처리 · ${kst(state.at)}` : `${kst(state.until)}까지 음소거`;
}

function stateLine(state: IncidentState): string {
  const by = isSlackUserId(state.by) ? ` · <@${state.by}>` : "";
  return `${stateSummary(state)}${by}`;
}

export type MessageOptions = {
  ownerUserId?: string;
  state?: IncidentState;
  // 같은 시각 에러가 난 다른 사이트의 이름을 찾는 설정. 없으면 그 줄을 적지 않는다.
  sites?: readonly Target[];
  // Claude 요약을 만들지 못한 이유. 상세 알림을 처음 보낼 때만 적는다.
  analysisFailure?: AnalysisFailure | null;
};

/**
 * incident 하나의 상세 메시지. P1이면 담당자를 멘션한다.
 * 제목 → Claude 요약(있으면) → 규칙이 모은 근거 → 버튼. 등급·알림 여부는 규칙이 정하고 요약은 참고용이다.
 * `state`가 있으면 버튼 대신 처리 결과를 적는다(버튼을 누른 뒤 원래 메시지를 바꿀 때).
 */
export function incidentMessage(
  target: Target,
  incident: Incident,
  { ownerUserId, state, sites = [], analysisFailure = null }: MessageOptions = {},
): SlackMessage {
  const call = !state && incident.severity === "P1" ? mention(ownerUserId) : "";
  const title = headline(target, incident);
  const analysis = currentAnalysis(incident)?.result ?? null;
  const body = [
    `${call}*${title}*`,
    ...(analysis ? analysisLines(analysis) : []),
    ...details(incident, !state, sites),
  ].join("\n");

  const blocks: SlackBlock[] = [{ type: "section", text: mrkdwn(clip(body, SECTION_LIMIT)) }];
  const note = analysis
    ? "요약: Claude · 참고용 (등급·알림은 규칙 기준)"
    : analysisFailure
      ? `요약 없음 · ${FAILURE_LABEL[analysisFailure]}`
      : null;
  if (!state && note) blocks.push({ type: "context", elements: [mrkdwn(note)] });
  blocks.push(
    state
      ? { type: "context", elements: [mrkdwn(stateLine(state))] }
      : { type: "actions", elements: buttons(incident) },
  );
  // 버튼 응답으로 바꾸는 메시지는 parse 옵션을 줄 수 없다. 대체 문구에 외부 글자를 넣지 않는다.
  const text = state
    ? `[${incident.severity}][${escapeSlack(target.name)}] ${stateSummary(state)}`
    : `${call}${title}`;
  return { channel: target.slackChannel, text: clip(text, SECTION_LIMIT), blocks };
}

function linkLine(incident: Incident): string {
  const link = safeLink(incident.evidence.link);
  const open = link ? ` · <${link.replaceAll("&", "&amp;")}|열기>` : "";
  return `• [${incident.severity}] ${escapeSlack(incident.title)}${open}`;
}

/** 상세 메시지 상한을 넘은 incident를 한 건으로 묶는다. 버튼은 없다. */
export function bundleMessage(target: Target, incidents: readonly Incident[]): SlackMessage {
  const shown = incidents.slice(0, BUNDLE_LINE_LIMIT);
  const hidden = incidents.length - shown.length;
  const title = `[${escapeSlack(target.name)}] 상세 알림 ${DETAIL_LIMIT}건 밖의 ${incidents.length}건`;

  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: mrkdwn(
        `*${title}*\n등급 높은 순으로 상세 알림을 보내고 남은 incident입니다. 전달 완료로 처리했고, 등급이 오르면 다시 알립니다.`,
      ),
    },
    ...shown.map(
      (incident): SlackBlock => ({
        type: "section",
        text: mrkdwn(clip(linkLine(incident), SECTION_LIMIT)),
      }),
    ),
  ];
  if (hidden > 0) {
    blocks.push({ type: "context", elements: [mrkdwn(`그 밖에 ${hidden}건은 목록에 넣지 않았습니다.`)] });
  }
  return { channel: target.slackChannel, text: title, blocks };
}

/** 등급 높은 순으로 상세 5건과 묶음으로 나눈다. 같은 등급은 받은 순서를 유지한다. */
export function planReport(pending: readonly Incident[]): {
  detailed: Incident[];
  bundled: Incident[];
} {
  const sorted = [...pending].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return { detailed: sorted.slice(0, DETAIL_LIMIT), bundled: sorted.slice(DETAIL_LIMIT) };
}

export type DeliveryResult = {
  // 보낸 상세 메시지 수
  detailed: number;
  // 이번에 Claude가 새로 요약한 수(저장된 요약을 다시 쓴 건 빼고)
  analyzed: number;
  // 요약을 만들지 못한 이유. 알림은 템플릿으로 나갔다.
  analysisFailures: AnalysisFailure[];
  // 묶음 메시지에 넣어 보낸 incident 수
  bundled: number;
  // 표를 받은 뒤 등급 상승·해결·음소거로 표가 무효가 돼 건너뛴 수
  skipped: number;
  // 전송이나 기록이 실패하면 남은 전송을 멈춘다. 표는 돌려줘 다음 실행이 다시 보낸다.
  error: unknown;
};

export type DeliveryOptions = {
  ownerUserId?: string;
  // 테스트에서 실제로 기다리지 않게 바꾼다.
  sleep?: (ms: number) => Promise<void>;
  // 새 전송·재시도 대기를 시작하기 전에만 확인한다. `afterMs`는 그만큼 기다린 뒤에도 시간이 남는지 묻는다.
  // 보내는 중인 전송은 끊지 않는다(끊으면 Slack은 받았는데 다음 실행이 또 보낸다).
  shouldStop?: (afterMs?: number) => boolean;
  // 상세 알림의 Claude 요약. 없으면 템플릿만 보낸다(webhook).
  analyzer?: Analyzer;
  // Sentry 최신 이벤트의 스택(파일·함수·줄). 실패하면 스택 없이 보낸다.
  frames?: (incident: Incident) => Promise<MaskedFrame[]>;
  // 설정된 모든 사이트. 같은 시각 에러가 난 다른 사이트의 이름을 적는다.
  sites?: readonly Target[];
};

/** Claude에게 넘길 근거. 규칙이 이미 모은 값만 넣는다. */
export function analysisInput(
  target: Target,
  incident: Incident,
  frames: readonly MaskedFrame[],
  otherSites: readonly string[],
): AnalysisInput {
  const { evidence } = incident;
  const deploy = evidence.relatedDeploy;
  return {
    site: target.name,
    severity: incident.severity,
    area: incident.area,
    kind: evidence.kind,
    title: incident.title,
    tag: evidence.tag,
    route: evidence.route,
    count: evidence.count,
    users: evidence.users,
    recentIncrease: evidence.source === "sentry" ? windowIncrease(evidence.snapshots) : 0,
    episode: incident.episode,
    firstSeen: incident.firstSeen,
    lastSeen: incident.lastSeen,
    frames,
    relatedDeploy: deploy
      ? { liveAt: deploy.readyAt ?? deploy.createdAt, sha: deploy.sha ? deploy.sha.slice(0, 7) : null }
      : null,
    otherSitesWithErrors: otherSites,
  };
}

type Prepared = { analyzed: boolean; failure: AnalysisFailure | null };

/**
 * 상세 알림 하나의 보조 정보(스택·같은 시각 다른 사이트·Claude 요약)를 모아 저장한다.
 * 이 회차·등급의 요약이 이미 있으면 Claude를 다시 부르지 않는다(전송 실패 뒤 다시 보낼 때).
 * 배포 실패는 오류 문구가 없어 요약할 거리가 없으므로 부르지 않는다.
 * 스택·Claude 실패는 알림을 막지 않는다. DB 오류만 던진다.
 */
async function prepareDetail(
  db: Client,
  target: Target,
  incident: Incident,
  claim: string,
  now: Date,
  { analyzer, frames: fetchFrames, sites = [], shouldStop }: DeliveryOptions & { shouldStop: (afterMs?: number) => boolean },
): Promise<Prepared> {
  const key = analysisKey(incident);
  const stored = incident.analysis;
  // 같은 알림을 다시 보낼 때만 재사용한다. 그사이 메시지가 나갔으면 새 알림이라 근거(수·동시 장애)를 다시 모은다.
  if (stored?.key === key && stored.previousTs === incident.slackTs && stored.result) {
    return { analyzed: false, failure: null };
  }

  const [correlated, frames] = await Promise.all([
    findCorrelatedTargets(db, incident),
    incident.evidence.source === "sentry" && fetchFrames
      ? fetchFrames(incident).catch((): MaskedFrame[] => [])
      : Promise.resolve<MaskedFrame[]>([]),
  ]);

  let result: Analysis | null = null;
  let model: string | null = null;
  let failure: AnalysisFailure | null = null;
  if (analyzer && incident.evidence.kind !== "deploy.failed") {
    if (shouldStop(ANALYSIS_TIMEOUT_MS + ANALYSIS_SEND_RESERVE_MS)) {
      failure = "no_time";
    } else {
      const names = correlated.flatMap((id) => sites.find((site) => site.id === id)?.name ?? []);
      const outcome = await analyzer(analysisInput(target, incident, frames, names));
      if (outcome.ok) ({ analysis: result, model } = outcome);
      else failure = outcome.reason;
    }
  }

  await saveAnalysis(db, incident.id, claim, {
    key,
    previousTs: incident.slackTs,
    result,
    model,
    frames,
    correlated,
    at: now.toISOString(),
  });
  return { analyzed: result !== null, failure };
}

/** 전송 자체의 실패(Slack 오류 등). DB 오류와 구분해 전송 실패로만 남기려고 감싼다. */
class SendFailed extends Error {
  constructor(readonly original: unknown) {
    super("Slack 전송 실패");
  }
}

/** 실행 예산이 끝나 남은 전송을 다음 실행에 맡겼다. */
export class DeliveryStopped extends Error {
  override name = "TimeoutError";

  constructor() {
    super("실행 예산이 끝나 남은 전송을 멈췄습니다");
  }
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** rate limit이면 Slack이 알려 준 만큼 기다렸다가 한 번만 다시 보낸다. */
async function sendWithRetry(
  send: Send,
  message: SlackMessage,
  sleep: (ms: number) => Promise<void>,
  shouldStop: (afterMs?: number) => boolean,
): Promise<{ ts: string }> {
  try {
    return await send(message);
  } catch (error) {
    const retryAfter = error instanceof SlackError ? error.retryAfterMs : undefined;
    if (
      error instanceof SlackError &&
      error.reason === "rate_limit" &&
      retryAfter !== undefined &&
      retryAfter <= MAX_RETRY_WAIT_MS &&
      // 기다린 뒤 다시 보낼 시간이 없으면 다음 실행에 맡긴다
      !shouldStop(retryAfter)
    ) {
      await sleep(retryAfter);
      return send(message);
    }
    throw error;
  }
}

/**
 * 한 사이트의 미전송 incident를 보낸다. 상세 5건 + 나머지 묶음 1건.
 * 미전송 전부에 이 실행의 표를 한 번에 붙이고 그 순간의 내용으로 상세·묶음을 나눈다.
 * 보내기 직전에 표가 아직 유효한지 확인한다. 그사이 등급이 오르거나 해결·음소거되면 건너뛰고,
 * 오른 incident는 다음 실행에서 상세로 나간다. 보내지 못한 건은 끝에서 표를 돌려준다.
 */
export async function deliverPending(
  db: Client,
  target: Target,
  now: Date,
  send: Send,
  options: DeliveryOptions = {},
): Promise<DeliveryResult> {
  const { ownerUserId, sleep = wait, shouldStop = () => false, sites = [] } = options;
  const result: DeliveryResult = {
    detailed: 0,
    analyzed: 0,
    analysisFailures: [],
    bundled: 0,
    skipped: 0,
    error: null,
  };
  const { claim, incidents } = await claimPending(db, target.id, now);
  if (incidents.length === 0) return result;

  const { detailed, bundled } = planReport(incidents);
  const failures = new Map<number, AnalysisFailure>();
  let sentBefore = false;
  // 모두 같은 채널로 간다. 이어 보낼 때 간격을 둔다.
  const paced = async (message: SlackMessage) => {
    if (sentBefore) await sleep(SEND_INTERVAL_MS);
    if (shouldStop()) throw new DeliveryStopped();
    sentBefore = true;
    try {
      return await sendWithRetry(send, message, sleep, shouldStop);
    } catch (error) {
      throw new SendFailed(error);
    }
  };

  try {
    // 상세 알림의 요약을 한꺼번에 만든다. Claude 호출을 하나씩 기다리면 첫 알림이 그만큼 늦는다.
    // 하나가 DB 오류로 실패해도 나머지가 끝난 뒤 던진다(표를 돌려준 뒤에 쓰지 않게).
    const prepared = await Promise.allSettled(
      detailed.map((incident) => prepareDetail(db, target, incident, claim, now, { ...options, shouldStop })),
    );
    for (const [index, outcome] of prepared.entries()) {
      if (outcome.status === "rejected") throw outcome.reason;
      if (outcome.value.analyzed) result.analyzed++;
      if (outcome.value.failure) {
        result.analysisFailures.push(outcome.value.failure);
        failures.set(detailed[index].id, outcome.value.failure);
      }
    }

    for (const planned of detailed) {
      const incident = await getClaimedIncident(db, planned.id, claim);
      if (!incident) {
        result.skipped++;
        continue;
      }
      const message = incidentMessage(target, incident, {
        ownerUserId,
        sites,
        analysisFailure: failures.get(incident.id) ?? null,
      });
      const { ts } = await paced(message);
      await completeNotification(db, incident.id, claim, ts, now);
      result.detailed++;
    }

    if (bundled.length > 0) {
      const ids = new Set(bundled.map(({ id }) => id));
      const still = (await listClaimed(db, claim)).filter(({ id }) => ids.has(id));
      result.skipped += ids.size - still.length;
      if (still.length > 0) {
        const { ts } = await paced(bundleMessage(target, still));
        result.bundled = await completeNotifications(
          db,
          still.map(({ id }) => id),
          claim,
          ts,
          now,
        );
      }
    }
  } catch (error) {
    // 전송 실패·예산 종료만 결과로 남긴다. DB 오류는 던져 호출한 쪽이 실패로 처리하게 한다
    // (webhook은 500을 돌려 Vercel이 다시 보낸다). 어느 쪽이든 표는 아래에서 돌려준다.
    if (error instanceof SendFailed) result.error = error.original;
    else if (error instanceof DeliveryStopped) result.error = error;
    else throw error;
  } finally {
    await releaseClaim(db, claim);
  }
  return result;
}

function ephemeral(text: string): SlackResponse {
  return { response_type: "ephemeral", replace_original: false, text };
}

function replace(message: SlackMessage): SlackResponse {
  return { replace_original: true, text: message.text, blocks: message.blocks };
}

/**
 * 버튼 동작을 ops-bot 상태에 반영한다. Sentry에는 쓰지 않는다(D20).
 * 해결은 그 회차 메시지에서만 받는다. 다시 열린 뒤 옛 메시지로 새 회차를 닫지 않게 한다.
 */
export async function handleAction(
  db: Client,
  targets: readonly Target[],
  interaction: Extract<Interaction, { kind: "action" }>,
  now: Date,
): Promise<SlackResponse> {
  const incident = await getIncident(db, interaction.incidentId);
  if (!incident) return ephemeral("이 incident를 찾을 수 없습니다. 보관 기간이 지나 지워졌을 수 있습니다.");
  const target = targets.find(({ id }) => id === incident.target);
  if (!target) return ephemeral("설정에 없는 사이트의 incident입니다.");

  const by = interaction.userId;
  if (interaction.action === "resolve") {
    // 회차 확인은 해결 UPDATE의 조건으로 한다. 따로 확인하면 그 사이에 다시 열릴 수 있다.
    if (!(await resolveIncident(db, target.id, incident.fingerprint, now, interaction.episode))) {
      const latest = await getIncident(db, incident.id);
      if (latest && latest.episode !== interaction.episode) {
        return ephemeral(
          `이 메시지는 ${interaction.episode}회차 알림입니다. 지금은 ${latest.episode}회차이니 새 알림의 버튼을 눌러 주세요.`,
        );
      }
      return ephemeral("이미 해결된 incident입니다.");
    }
    const updated = (await getIncident(db, incident.id)) ?? incident;
    return replace(incidentMessage(target, updated, { state: { kind: "resolved", at: now, by }, sites: targets }));
  }

  const until = new Date(
    now.getTime() + (interaction.action === "mute_1h" ? MUTE_SHORT_MS : MUTE_LONG_MS),
  );
  await muteIncident(db, target.id, incident.fingerprint, until, now);
  const updated = (await getIncident(db, incident.id)) ?? incident;
  return replace(incidentMessage(target, updated, { state: { kind: "muted", until, by }, sites: targets }));
}
