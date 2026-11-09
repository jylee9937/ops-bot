import type { Client } from "@libsql/client";
import {
  claimPending,
  completeNotification,
  completeNotifications,
  getClaimedIncident,
  getIncident,
  listClaimed,
  muteIncident,
  releaseClaim,
  resolveIncident,
  type Incident,
} from "./incidents";
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

function details(incident: Incident): string[] {
  const { evidence } = incident;
  const lines = [`${reason(incident)} · 영역 ${escapeSlack(incident.area)}`];
  if (evidence.source === "sentry") {
    lines.push(`누적 ${evidence.count}회 · 영향 사용자 ${evidence.users}명`);
  }
  lines.push(`처음 ${kst(incident.firstSeen)} · 마지막 ${kst(incident.lastSeen)} (KST)`);
  if (evidence.route) lines.push(`경로 ${escapeSlack(evidence.route)}`);
  if (evidence.relatedDeploy) {
    const { sha, deploymentId, readyAt, createdAt } = evidence.relatedDeploy;
    const name = sha ? sha.slice(0, 7) : deploymentId;
    lines.push(`배포 직후: ${kst(readyAt ?? createdAt)}에 공개된 배포 ${escapeSlack(name)}`);
  }
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

/**
 * incident 하나의 상세 메시지. P1이면 담당자를 멘션한다.
 * `state`가 있으면 버튼 대신 처리 결과를 적는다(버튼을 누른 뒤 원래 메시지를 바꿀 때).
 */
export function incidentMessage(
  target: Target,
  incident: Incident,
  { ownerUserId, state }: { ownerUserId?: string; state?: IncidentState } = {},
): SlackMessage {
  const call = !state && incident.severity === "P1" ? mention(ownerUserId) : "";
  const title = headline(target, incident);
  const body = [`${call}*${title}*`, ...details(incident)].join("\n");

  const blocks: SlackBlock[] = [{ type: "section", text: mrkdwn(clip(body, SECTION_LIMIT)) }];
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
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** rate limit이면 Slack이 알려 준 만큼 기다렸다가 한 번만 다시 보낸다. */
async function sendWithRetry(
  send: Send,
  message: SlackMessage,
  sleep: (ms: number) => Promise<void>,
): Promise<{ ts: string }> {
  try {
    return await send(message);
  } catch (error) {
    const retryAfter = error instanceof SlackError ? error.retryAfterMs : undefined;
    if (
      error instanceof SlackError &&
      error.reason === "rate_limit" &&
      retryAfter !== undefined &&
      retryAfter <= MAX_RETRY_WAIT_MS
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
  { ownerUserId, sleep = wait }: DeliveryOptions = {},
): Promise<DeliveryResult> {
  const result: DeliveryResult = { detailed: 0, bundled: 0, skipped: 0, error: null };
  const { claim, incidents } = await claimPending(db, target.id, now);
  if (incidents.length === 0) return result;

  const { detailed, bundled } = planReport(incidents);
  let sentBefore = false;
  // 모두 같은 채널로 간다. 이어 보낼 때 간격을 둔다.
  const paced = async (message: SlackMessage) => {
    if (sentBefore) await sleep(SEND_INTERVAL_MS);
    sentBefore = true;
    return sendWithRetry(send, message, sleep);
  };

  try {
    for (const planned of detailed) {
      const incident = await getClaimedIncident(db, planned.id, claim);
      if (!incident) {
        result.skipped++;
        continue;
      }
      const { ts } = await paced(incidentMessage(target, incident, { ownerUserId }));
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
    result.error = error;
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
    return replace(incidentMessage(target, updated, { state: { kind: "resolved", at: now, by } }));
  }

  const until = new Date(
    now.getTime() + (interaction.action === "mute_1h" ? MUTE_SHORT_MS : MUTE_LONG_MS),
  );
  await muteIncident(db, target.id, incident.fingerprint, until, now);
  const updated = (await getIncident(db, incident.id)) ?? incident;
  return replace(incidentMessage(target, updated, { state: { kind: "muted", until, by } }));
}
