// 고정 본문은 Vercel Webhooks API 문서(deployment.error)의 형식을 따른 가짜 데이터다.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Target } from "../targets";
import sample from "./__fixtures__/vercel-webhook-deployment-error.json";
import { parseVercelWebhook, verifyVercelSignature } from "./vercel-webhook";

const SECRET = "webhook-test-secret";
const NOW = new Date(sample.createdAt + 5_000);
const TARGET: Target = {
  id: "site-a",
  name: "사이트 A",
  vercel: { projectId: "prj_a", productionBranch: "main" },
  slackChannel: "#ops-a",
  areas: [],
};

const sign = (body: string, secret = SECRET) => createHmac("sha1", secret).update(body).digest("hex");
const event = (overrides: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) =>
  JSON.stringify({ ...sample, ...overrides, payload: { ...sample.payload, ...payload } });

describe("verifyVercelSignature", () => {
  const body = JSON.stringify(sample);

  it("본문의 HMAC-SHA1(16진수)이 맞으면 통과한다", () => {
    expect(verifyVercelSignature(SECRET, body, sign(body))).toBe(true);
    expect(verifyVercelSignature(SECRET, body, sign(body).toUpperCase())).toBe(true);
  });

  it("본문·비밀이 다르거나 형식이 틀리면 예외 없이 거부한다", () => {
    expect(verifyVercelSignature(SECRET, `${body} `, sign(body))).toBe(false);
    expect(verifyVercelSignature("other-secret", body, sign(body))).toBe(false);
    expect(verifyVercelSignature(SECRET, body, null)).toBe(false);
    expect(verifyVercelSignature("", body, sign(body, ""))).toBe(false);
    expect(verifyVercelSignature(SECRET, body, "abc")).toBe(false);
    expect(verifyVercelSignature(SECRET, body, `sha1=${sign(body)}`)).toBe(false);
    // SHA-256 길이(64자)는 형식부터 다르다
    expect(verifyVercelSignature(SECRET, body, createHmac("sha256", SECRET).update(body).digest("hex"))).toBe(false);
  });
});

describe("parseVercelWebhook", () => {
  it("운영 배포 실패를 폴링과 같은 지문의 신호로 만든다", () => {
    const result = parseVercelWebhook(JSON.stringify(sample), [TARGET], NOW);
    expect(result).toEqual({
      kind: "deploy_failed",
      target: TARGET,
      signal: {
        target: "site-a",
        source: "vercel",
        kind: "deploy.failed",
        fingerprint: "vercel:dpl_ExampleFailed01:ERROR",
        sourceId: "dpl_ExampleFailed01",
        title: "배포 실패",
        tag: null,
        route: null,
        count: 1,
        users: 0,
        firstSeen: new Date(sample.createdAt).toISOString(),
        lastSeen: new Date(sample.createdAt).toISOString(),
        link: "https://vercel.com/example-team/site-a/ExampleFailed01",
      },
    });
  });

  it.each(["deployment.created", "deployment.succeeded", "deployment.canceled", "project.created"])(
    "%s 이벤트는 무시한다",
    (type) => {
      expect(parseVercelWebhook(event({ type }), [TARGET], NOW)).toEqual({ kind: "ignore", reason: "event" });
    },
  );

  it.each([null, "preview", "staging"])("target이 %j인 배포는 무시한다", (target) => {
    expect(parseVercelWebhook(event({}, { target }), [TARGET], NOW)).toEqual({ kind: "ignore", reason: "target" });
  });

  it("설정에 없는 프로젝트는 무시한다", () => {
    expect(parseVercelWebhook(event({}, { project: { id: "prj_other" } }), [TARGET], NOW)).toEqual({
      kind: "ignore",
      reason: "project",
    });
  });

  it("25시간보다 오래되거나 5분 넘게 미래인 이벤트는 재전송으로 보고 무시한다", () => {
    const hour = 60 * 60_000;
    expect(parseVercelWebhook(event(), [TARGET], new Date(sample.createdAt + 24 * hour))).toMatchObject({
      kind: "deploy_failed",
    });
    expect(parseVercelWebhook(event(), [TARGET], new Date(sample.createdAt + 26 * hour))).toEqual({
      kind: "ignore",
      reason: "stale",
    });
    expect(parseVercelWebhook(event(), [TARGET], new Date(sample.createdAt - 6 * 60_000))).toEqual({
      kind: "ignore",
      reason: "stale",
    });
  });

  it("https가 아닌 링크는 형식 오류로 보고, 링크가 없으면 기본 링크를 쓴다", () => {
    const result = parseVercelWebhook(
      event({}, { links: { deployment: "javascript:alert(1)" } }),
      [TARGET],
      NOW,
    );
    expect(result).toEqual({ kind: "invalid" });
    const noLink = parseVercelWebhook(event({}, { links: null }), [TARGET], NOW);
    expect(noLink.kind === "deploy_failed" && noLink.signal.link).toBe("https://vercel.com/dashboard");
  });

  it("형식이 다르면 invalid다", () => {
    expect(parseVercelWebhook("not json", [TARGET], NOW)).toEqual({ kind: "invalid" });
    expect(parseVercelWebhook(JSON.stringify({ type: "deployment.error" }), [TARGET], NOW)).toEqual({
      kind: "invalid",
    });
    expect(parseVercelWebhook(event({}, { deployment: { id: "../etc" } }), [TARGET], NOW)).toEqual({
      kind: "invalid",
    });
    expect(parseVercelWebhook(event({}, { project: null }), [TARGET], NOW)).toEqual({ kind: "invalid" });
  });
});
