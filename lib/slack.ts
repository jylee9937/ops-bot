import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
const REQUEST_TIMEOUT_MS = 10_000;
// Slack 권장값. 이보다 오래된 요청은 재전송 공격으로 본다.
const SIGNATURE_TOLERANCE_S = 300;
// 버튼·명령 요청은 수 KB다. 서명 계산 전에 큰 본문을 거른다.
export const MAX_SLACK_BODY_BYTES = 64 * 1024;
// 명령 뒤에 붙는 글자. 하위 명령과 인자 하나면 충분하다.
const MAX_COMMAND_TEXT = 200;
// Slack section 블록 글자 한도
const SECTION_TEXT_LIMIT = 3_000;

const USER_ID = /^[UW][A-Z0-9]{2,20}$/;
const ERROR_CODE = /^[a-z_]{1,64}$/;

export type MrkdwnText = { type: "mrkdwn"; text: string; verbatim: true };
export type PlainText = { type: "plain_text"; text: string; emoji: boolean };
export type ButtonElement = {
  type: "button";
  action_id: string;
  text: PlainText;
  url?: string;
  value?: string;
  style?: "primary" | "danger";
};
export type SlackBlock =
  | { type: "section"; text: MrkdwnText }
  | { type: "context"; elements: MrkdwnText[] }
  | { type: "actions"; elements: ButtonElement[] };

/** 채널에 보낼 메시지. `text`는 알림과 화면 낭독기에 쓰는 대체 문구다. */
export type SlackMessage = { channel: string; text: string; blocks: SlackBlock[] };

/** 버튼·명령 응답(`response_url`)으로 보내는 내용. 원래 메시지를 바꾸거나 부른 사람에게만 보인다. */
export type SlackResponse =
  | { replace_original: true; text: string; blocks: SlackBlock[] }
  | { response_type: "ephemeral"; replace_original: false; text: string; blocks: SlackBlock[] };

/**
 * 부른 사람에게만 보이는 응답. 원래 메시지는 그대로 둔다.
 * 모델 요약 같은 외부 글자의 일반 URL이 자동 링크가 되지 않게 verbatim 블록으로 보낸다. `text`는 알림용 대체 문구다.
 */
export function ephemeral(text: string): SlackResponse {
  const chars = Array.from(text);
  const shown = chars.length <= SECTION_TEXT_LIMIT ? text : `${chars.slice(0, SECTION_TEXT_LIMIT - 1).join("")}…`;
  return { response_type: "ephemeral", replace_original: false, text, blocks: [{ type: "section", text: mrkdwn(shown) }] };
}

/**
 * 외부에서 온 글자를 Slack 문법으로 해석되지 않게 한다. `<!channel>`·`<@U…>`·`<url|글자>`는
 * 모두 `<`로 시작하므로 세 글자만 바꾸면 멘션과 가짜 링크가 글자 그대로 보인다.
 */
export function escapeSlack(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** 우리가 쓴 문구용 mrkdwn. 자동 링크·채널 이름 해석을 끈다. */
export function mrkdwn(text: string): MrkdwnText {
  return { type: "mrkdwn", text, verbatim: true };
}

export function plainText(text: string): PlainText {
  return { type: "plain_text", text, emoji: false };
}

export function isSlackUserId(value: string | undefined): value is string {
  return value !== undefined && USER_ID.test(value);
}

export type SlackErrorReason =
  | "auth"
  | "channel"
  | "rate_limit"
  | "server"
  | "bad_request"
  | "network"
  | "invalid_response";

/** 토큰과 요청 본문은 메시지에 넣지 않는다. Slack 오류 코드만 남긴다. */
export class SlackError extends Error {
  override name = "SlackError";

  constructor(
    readonly reason: SlackErrorReason,
    readonly code?: string,
    // rate_limit일 때 Slack이 알려 준 대기 시간
    readonly retryAfterMs?: number,
  ) {
    super(`Slack 전송 실패: ${reason}${code ? ` (${code})` : ""}`);
  }
}

/** `Retry-After`(초)를 밀리초로. 형식이 다르거나 1시간을 넘으면 버린다. */
function retryAfterOf(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw || !/^[0-9]{1,4}$/.test(raw)) return undefined;
  const seconds = Number(raw);
  return seconds <= 3_600 ? seconds * 1_000 : undefined;
}

const AUTH_ERRORS = new Set([
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "missing_scope",
]);
const CHANNEL_ERRORS = new Set(["channel_not_found", "not_in_channel", "is_archived"]);
const RATE_LIMIT_ERRORS = new Set(["ratelimited", "rate_limited"]);

const postMessageResponse = z.object({
  ok: z.boolean(),
  ts: z.string().min(1).optional(),
  error: z.string().optional(),
});

export type SlackRequestOptions = { fetchImpl?: typeof fetch; signal?: AbortSignal };

function requestSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * 메시지를 보내고 `ts`를 돌려준다. 미리보기(unfurl)와 자동 링크는 끈다.
 * Slack은 실패해도 HTTP 200에 `ok: false`를 주므로 본문까지 확인한다.
 */
export async function postMessage(
  message: SlackMessage,
  token: string,
  { fetchImpl = fetch, signal }: SlackRequestOptions = {},
): Promise<{ ts: string }> {
  let response: Response;
  try {
    response = await fetchImpl(POST_MESSAGE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ ...message, parse: "none", unfurl_links: false, unfurl_media: false }),
      signal: requestSignal(signal),
    });
  } catch {
    throw new SlackError("network");
  }

  if (response.status === 429) throw new SlackError("rate_limit", undefined, retryAfterOf(response));
  if (response.status >= 500) throw new SlackError("server", String(response.status));
  if (!response.ok) throw new SlackError("bad_request", String(response.status));

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new SlackError("invalid_response");
  }
  const parsed = postMessageResponse.safeParse(json);
  if (!parsed.success) throw new SlackError("invalid_response");

  const { ok, ts, error } = parsed.data;
  if (ok && ts) return { ts };
  if (ok) throw new SlackError("invalid_response");

  const code = error && ERROR_CODE.test(error) ? error : undefined;
  if (code && AUTH_ERRORS.has(code)) throw new SlackError("auth", code);
  if (code && CHANNEL_ERRORS.has(code)) throw new SlackError("channel", code);
  if (code && RATE_LIMIT_ERRORS.has(code)) {
    throw new SlackError("rate_limit", code, retryAfterOf(response));
  }
  throw new SlackError("bad_request", code);
}

/** 버튼을 누른 메시지에 응답한다. 주소는 `parseInteraction`이 Slack 주소인지 확인했다. */
export async function respond(
  responseUrl: string,
  body: SlackResponse,
  { fetchImpl = fetch, signal }: SlackRequestOptions = {},
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      signal: requestSignal(signal),
    });
  } catch {
    throw new SlackError("network");
  }
  if (!response.ok) {
    throw new SlackError(response.status >= 500 ? "server" : "bad_request", String(response.status));
  }
}

/**
 * Slack 서명을 확인한다. 본문은 파싱하기 전 원문 그대로 넘긴다.
 * 시각이 5분 넘게 어긋나거나 형식이 다르면 계산하지 않고 거부한다.
 */
export function verifySlackSignature({
  secret,
  body,
  timestamp,
  signature,
  now,
}: {
  secret: string;
  body: string;
  timestamp: string | null;
  signature: string | null;
  now: Date;
}): boolean {
  if (!secret || !timestamp || !signature) return false;
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > SIGNATURE_TOLERANCE_S) return false;

  const expected = Buffer.from(
    `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`,
  );
  const received = Buffer.from(signature);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export type SlackRequestCheck =
  // signature는 확인을 통과한 서명이다. 요청마다 달라 같은 요청이 다시 왔는지 가리는 데 쓴다.
  | { ok: true; body: string; ownerUserId: string; signature: string }
  | { ok: false; status: 401 | 413 | 500 };

/**
 * Slack에서 온 요청(버튼·슬래시 명령)을 확인한다. 설정 → 크기 → 서명 순서로 본다.
 * 통과하면 서명을 확인한 원문과 담당자 id를 돌려준다. 누가 보냈는지는 route가 본문을 파싱한 뒤 비교한다.
 */
export async function readSlackRequest(
  request: Request,
  { secret, ownerUserId, now }: { secret: string | undefined; ownerUserId: string | undefined; now: Date },
): Promise<SlackRequestCheck> {
  if (!secret || !isSlackUserId(ownerUserId)) return { ok: false, status: 500 };

  const body = await request.text();
  if (body.length > MAX_SLACK_BODY_BYTES) return { ok: false, status: 413 };

  const signature = request.headers.get("x-slack-signature");
  const verified = verifySlackSignature({
    secret,
    body,
    timestamp: request.headers.get("x-slack-request-timestamp"),
    signature,
    now,
  });
  if (!verified || !signature) return { ok: false, status: 401 };
  return { ok: true, body, ownerUserId, signature };
}

export const ACTION_IDS = ["resolve", "mute_1h", "mute_30d"] as const;
export type ActionId = (typeof ACTION_IDS)[number];
// 링크 버튼도 요청이 온다. 응답만 하고 아무것도 바꾸지 않는다.
export const LINK_ACTION_ID = "open_link";

export type Interaction =
  | { kind: "ignore" }
  | { kind: "invalid" }
  | {
      kind: "action";
      userId: string;
      responseUrl: string;
      action: ActionId;
      incidentId: number;
      episode: number;
    };

const interactionType = z.object({ type: z.string() });
const blockActions = z.object({
  type: z.literal("block_actions"),
  user: z.object({ id: z.string() }),
  response_url: z.string(),
  actions: z
    .array(z.object({ action_id: z.string(), value: z.string().optional() }))
    .min(1),
});
const BUTTON_VALUE = /^(\d{1,12}):(\d{1,6})$/;

function isSlackResponseUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname === "hooks.slack.com" && url.port === "";
  } catch {
    return false;
  }
}

/** 서명을 확인한 본문에서 버튼 동작을 꺼낸다. 버튼 값은 `incident id:회차`다. */
export function parseInteraction(body: string): Interaction {
  const raw = new URLSearchParams(body).get("payload");
  if (!raw) return { kind: "invalid" };

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { kind: "invalid" };
  }

  const type = interactionType.safeParse(json);
  if (!type.success) return { kind: "invalid" };
  if (type.data.type !== "block_actions") return { kind: "ignore" };

  const parsed = blockActions.safeParse(json);
  if (!parsed.success) return { kind: "invalid" };

  const { user, response_url: responseUrl, actions } = parsed.data;
  const [{ action_id: actionId, value }] = actions;
  if (!(ACTION_IDS as readonly string[]).includes(actionId)) return { kind: "ignore" };

  const match = value ? BUTTON_VALUE.exec(value) : null;
  if (!match || !isSlackUserId(user.id) || !isSlackResponseUrl(responseUrl)) {
    return { kind: "invalid" };
  }
  return {
    kind: "action",
    userId: user.id,
    responseUrl,
    action: actionId as ActionId,
    incidentId: Number(match[1]),
    episode: Number(match[2]),
  };
}

export type SlashCommand =
  | { kind: "ignore" }
  | { kind: "invalid" }
  | { kind: "command"; userId: string; responseUrl: string; text: string };

const slashCommand = z.object({
  command: z.string().regex(/^\/[^\s]{1,32}$/),
  user_id: z.string(),
  response_url: z.string(),
  text: z.string().max(MAX_COMMAND_TEXT).default(""),
});

/**
 * 서명을 확인한 본문에서 슬래시 명령을 꺼낸다. 명령 이름은 검사하지 않는다
 * (Preview 시험용으로 다른 이름을 등록할 수 있게). Slack의 인증서 확인 요청(`ssl_check`)은 무시한다.
 */
export function parseSlashCommand(body: string): SlashCommand {
  const params = new URLSearchParams(body);
  if (params.get("ssl_check") === "1") return { kind: "ignore" };

  const parsed = slashCommand.safeParse(Object.fromEntries(params));
  if (!parsed.success) return { kind: "invalid" };

  const { user_id: userId, response_url: responseUrl, text } = parsed.data;
  if (!isSlackUserId(userId) || !isSlackResponseUrl(responseUrl)) return { kind: "invalid" };
  return { kind: "command", userId, responseUrl, text };
}
