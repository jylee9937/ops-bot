import { describe, expect, it } from "vitest";
import { parseTargets, TargetsConfigError } from "./targets";

const site = {
  id: "site-a",
  name: "Site A",
  vercel: { projectId: "prj_a", productionBranch: "main" },
  sentry: { project: "site-a-prod" },
  slackChannel: "#ops-site-a",
  areas: [{ name: "인증", severity: "P1", match: ["auth"] }],
};

describe("parseTargets", () => {
  it("설정을 읽고 Sentry 환경 기본값을 production으로 채운다", () => {
    const [target] = parseTargets(JSON.stringify([site]));

    expect(target.sentry).toEqual({
      project: "site-a-prod",
      environment: "production",
    });
    expect(target.areas[0].severity).toBe("P1");
  });

  it("Sentry가 없는 사이트를 허용한다", () => {
    const withoutSentry = { ...site, id: "site-b", sentry: undefined };

    const targets = parseTargets(JSON.stringify([site, withoutSentry]));

    expect(targets[1].sentry).toBeUndefined();
  });

  it.each([
    ["값이 없음", undefined],
    ["JSON이 아님", "{nope"],
    ["빈 목록", "[]"],
    ["id 형식 오류", JSON.stringify([{ ...site, id: "Site A" }])],
    ["채널 형식 오류", JSON.stringify([{ ...site, slackChannel: "ops" }])],
    [
      "없는 등급",
      JSON.stringify([
        { ...site, areas: [{ name: "인증", severity: "P9", match: ["auth"] }] },
      ]),
    ],
    ["중복 id", JSON.stringify([site, site])],
  ])("거부한다: %s", (_label, raw) => {
    expect(() => parseTargets(raw)).toThrow(TargetsConfigError);
  });
});
