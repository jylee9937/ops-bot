import { describe, expect, it } from "vitest";
import { fakeFetch, jsonResponse } from "./sources/__fixtures__/fake-fetch";
import {
  escapeSlack,
  parseInteraction,
  postMessage,
  respond,
  SlackError,
  verifySlackSignature,
  type SlackMessage,
} from "./slack";

// Slack 문서(Verifying requests from Slack)의 예시 값
const DOC = {
  secret: "8f742231b10e8888abcd99yyyzzz85a5",
  timestamp: "1531420618",
  body: "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c",
  signature: "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503",
};
const docNow = (offsetSeconds = 0) => new Date((Number(DOC.timestamp) + offsetSeconds) * 1000);

const MESSAGE: SlackMessage = { channel: "#ops-a", text: "알림", blocks: [] };
const TOKEN = "xoxb-test-token";

describe("escapeSlack", () => {
  it("멘션·링크 문법을 글자로 바꾼다", () => {
    expect(escapeSlack("<!channel> 확인")).toBe("&lt;!channel&gt; 확인");
    expect(escapeSlack("<!here>")).toBe("&lt;!here&gt;");
    expect(escapeSlack("<@U123ABC>")).toBe("&lt;@U123ABC&gt;");
    expect(escapeSlack("<https://evil.example|로그인>")).toBe("&lt;https://evil.example|로그인&gt;");
  });

  it("&를 먼저 바꿔 두 번 바꾸지 않는다", () => {
    expect(escapeSlack("a & b")).toBe("a &amp; b");
    expect(escapeSlack("&lt;")).toBe("&amp;lt;");
  });
});

describe("verifySlackSignature", () => {
  const verify = (overrides: Partial<Parameters<typeof verifySlackSignature>[0]> = {}) =>
    verifySlackSignature({
      secret: DOC.secret,
      body: DOC.body,
      timestamp: DOC.timestamp,
      signature: DOC.signature,
      now: docNow(),
      ...overrides,
    });

  it("Slack 문서의 예시 서명을 통과시킨다", () => {
    expect(verify()).toBe(true);
  });

  it("본문이 한 글자라도 다르면 거부한다", () => {
    expect(verify({ body: `${DOC.body}&x=1` })).toBe(false);
    expect(verify({ body: DOC.body.replace("roadrunner", "roadrunneR") })).toBe(false);
  });

  it("다른 비밀로 만든 서명은 거부한다", () => {
    expect(verify({ secret: "another-secret" })).toBe(false);
  });

  it("5분 넘게 지난 요청은 서명이 맞아도 거부한다", () => {
    expect(verify({ now: docNow(300) })).toBe(true);
    expect(verify({ now: docNow(301) })).toBe(false);
    expect(verify({ now: docNow(-301) })).toBe(false);
  });

  it("헤더가 없거나 형식이 다르면 예외 없이 거부한다", () => {
    expect(verify({ timestamp: null })).toBe(false);
    expect(verify({ signature: null })).toBe(false);
    expect(verify({ secret: "" })).toBe(false);
    expect(verify({ timestamp: "1531420618.5" })).toBe(false);
    expect(verify({ signature: "v0=short" })).toBe(false);
    expect(verify({ signature: DOC.signature.replace("v0=", "v1=") })).toBe(false);
  });
});

describe("postMessage", () => {
  it("미리보기와 자동 링크를 끄고 보낸다", async () => {
    let sent: Record<string, unknown> = {};
    const impl: typeof fetch = async (_input, init) => {
      sent = JSON.parse(String(init?.body));
      return jsonResponse({ ok: true, ts: "1700000000.000100" });
    };

    await expect(postMessage(MESSAGE, TOKEN, { fetchImpl: impl })).resolves.toEqual({
      ts: "1700000000.000100",
    });
    expect(sent).toMatchObject({
      channel: "#ops-a",
      parse: "none",
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  it("토큰은 Authorization 헤더로만 보낸다", async () => {
    const fake = fakeFetch([jsonResponse({ ok: true, ts: "1.2" })]);
    await postMessage(MESSAGE, TOKEN, { fetchImpl: fake.impl });
    expect(fake.authorization).toEqual([`Bearer ${TOKEN}`]);
    expect(fake.urls[0].href).toBe("https://slack.com/api/chat.postMessage");
  });

  it.each([
    [{ ok: false, error: "invalid_auth" }, "auth"],
    [{ ok: false, error: "token_revoked" }, "auth"],
    [{ ok: false, error: "not_in_channel" }, "channel"],
    [{ ok: false, error: "channel_not_found" }, "channel"],
    [{ ok: false, error: "ratelimited" }, "rate_limit"],
    [{ ok: false, error: "invalid_blocks" }, "bad_request"],
    [{ ok: true }, "invalid_response"],
    [{ unexpected: true }, "invalid_response"],
  ])("HTTP 200이어도 본문 %j는 %s 실패다", async (body, reason) => {
    const fake = fakeFetch([jsonResponse(body)]);
    const error = await postMessage(MESSAGE, TOKEN, { fetchImpl: fake.impl }).catch((e) => e);
    expect(error).toBeInstanceOf(SlackError);
    expect(error.reason).toBe(reason);
    expect(error.message).not.toContain(TOKEN);
  });

  it.each([
    [429, "rate_limit"],
    [500, "server"],
    [503, "server"],
    [400, "bad_request"],
  ])("HTTP %i는 %s 실패다", async (status, reason) => {
    const fake = fakeFetch([new Response("", { status })]);
    await expect(postMessage(MESSAGE, TOKEN, { fetchImpl: fake.impl })).rejects.toMatchObject({
      reason,
    });
  });

  it("[리뷰 5] 429의 Retry-After를 밀리초로 남긴다", async () => {
    const fake = fakeFetch([
      new Response("", { status: 429, headers: { "retry-after": "3" } }),
      jsonResponse({ ok: false, error: "ratelimited" }, { headers: { "retry-after": "2" } }),
      new Response("", { status: 429, headers: { "retry-after": "soon" } }),
    ]);
    await expect(postMessage(MESSAGE, TOKEN, { fetchImpl: fake.impl })).rejects.toMatchObject({
      reason: "rate_limit",
      retryAfterMs: 3_000,
    });
    await expect(postMessage(MESSAGE, TOKEN, { fetchImpl: fake.impl })).rejects.toMatchObject({
      reason: "rate_limit",
      retryAfterMs: 2_000,
    });
    await expect(postMessage(MESSAGE, TOKEN, { fetchImpl: fake.impl })).rejects.toMatchObject({
      reason: "rate_limit",
      retryAfterMs: undefined,
    });
  });

  it("네트워크 오류와 시간 초과는 network 실패다", async () => {
    const fake = fakeFetch([new TypeError("fetch failed")]);
    await expect(postMessage(MESSAGE, TOKEN, { fetchImpl: fake.impl })).rejects.toMatchObject({
      reason: "network",
    });

    const aborted = AbortSignal.abort();
    const slow = fakeFetch([jsonResponse({ ok: true, ts: "1.2" })]);
    await expect(
      postMessage(MESSAGE, TOKEN, { fetchImpl: slow.impl, signal: aborted }),
    ).rejects.toMatchObject({ reason: "network" });
  });

  it("JSON이 아닌 응답은 invalid_response다", async () => {
    const fake = fakeFetch([new Response("<html>", { status: 200 })]);
    await expect(postMessage(MESSAGE, TOKEN, { fetchImpl: fake.impl })).rejects.toMatchObject({
      reason: "invalid_response",
    });
  });

  it("형식에 맞지 않는 오류 코드는 메시지에 넣지 않는다", async () => {
    const fake = fakeFetch([jsonResponse({ ok: false, error: "<!channel> 가짜" })]);
    const error = await postMessage(MESSAGE, TOKEN, { fetchImpl: fake.impl }).catch((e) => e);
    expect(error).toMatchObject({ reason: "bad_request", code: undefined });
    expect(error.message).toBe("Slack 전송 실패: bad_request");
  });
});

describe("respond", () => {
  it("response_url로 JSON을 보내고 실패하면 예외를 던진다", async () => {
    const fake = fakeFetch([new Response("ok"), new Response("", { status: 404 })]);
    const url = "https://hooks.slack.com/actions/T1/1/abc";
    const body = { response_type: "ephemeral", replace_original: false, text: "안내" } as const;

    await respond(url, body, { fetchImpl: fake.impl });
    await expect(respond(url, body, { fetchImpl: fake.impl })).rejects.toMatchObject({
      reason: "bad_request",
    });
    expect(fake.authorization).toEqual([null, null]);
  });
});

describe("parseInteraction", () => {
  const RESPONSE_URL = "https://hooks.slack.com/actions/T1/123/abc";
  const encode = (payload: unknown) =>
    new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const button = (overrides: Record<string, unknown> = {}, action: Record<string, unknown> = {}) =>
    encode({
      type: "block_actions",
      user: { id: "U0OWNER1" },
      response_url: RESPONSE_URL,
      actions: [{ action_id: "resolve", value: "12:2", ...action }],
      ...overrides,
    });

  it("버튼 동작과 incident id·회차를 꺼낸다", () => {
    expect(parseInteraction(button())).toEqual({
      kind: "action",
      userId: "U0OWNER1",
      responseUrl: RESPONSE_URL,
      action: "resolve",
      incidentId: 12,
      episode: 2,
    });
    expect(parseInteraction(button({}, { action_id: "mute_30d" }))).toMatchObject({
      action: "mute_30d",
    });
  });

  it("링크 버튼과 다른 종류의 요청은 무시한다", () => {
    expect(parseInteraction(button({}, { action_id: "open_link", value: undefined }))).toEqual({
      kind: "ignore",
    });
    expect(parseInteraction(encode({ type: "view_submission" }))).toEqual({ kind: "ignore" });
  });

  it("형식이 다른 요청은 invalid다", () => {
    expect(parseInteraction("")).toEqual({ kind: "invalid" });
    expect(parseInteraction("payload=%7Bbroken")).toEqual({ kind: "invalid" });
    expect(parseInteraction(button({}, { value: "12" }))).toEqual({ kind: "invalid" });
    expect(parseInteraction(button({}, { value: "12:2; DROP" }))).toEqual({ kind: "invalid" });
    expect(parseInteraction(button({ user: { id: "<!channel>" } }))).toEqual({ kind: "invalid" });
    expect(parseInteraction(button({ actions: [] }))).toEqual({ kind: "invalid" });
  });

  it("Slack 주소가 아닌 response_url은 받지 않는다", () => {
    for (const responseUrl of [
      "http://hooks.slack.com/actions/T1/1/a",
      "https://hooks.slack.com.evil.example/actions",
      "https://evil.example/?hooks.slack.com",
      "https://hooks.slack.com:8443/actions",
      "not a url",
    ]) {
      expect(parseInteraction(button({ response_url: responseUrl }))).toEqual({ kind: "invalid" });
    }
  });
});
