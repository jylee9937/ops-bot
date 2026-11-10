import { describe, expect, it } from "vitest";
import { maskLogMessage, maskRoute, tagOf } from "./mask";
import {
  baselineSnapshots,
  classify,
  ESCALATION_USERS,
  escalate,
  higherOf,
  initialBaseline,
  updateSnapshots,
  windowIncrease,
} from "./rules";
import type { Signal } from "./signal";
import type { Target } from "./targets";

const TARGET: Target = {
  id: "site-a",
  name: "사이트 A",
  vercel: { projectId: "prj_a", productionBranch: "main" },
  slackChannel: "#ops-a",
  areas: [
    { name: "강의 시청", severity: "P1", match: ["/api/playback"] },
    { name: "인증", severity: "P1", match: ["auth"] },
    { name: "공개 조회", severity: "P2", match: ["articles"] },
    { name: "어드민", severity: "P3", match: ["admin", "/api/a+b"] },
    { name: "늦은 영역", severity: "P2", match: ["auth"] },
  ],
};

function signal(tagText: string | null, route: string | null, kind: Signal["kind"] = "issue.ongoing"): Signal {
  return {
    target: "site-a",
    source: "sentry",
    kind,
    fingerprint: "sentry:1",
    sourceId: "1",
    title: maskLogMessage("실패"),
    tag: tagText ? tagOf(maskLogMessage(`[${tagText}] 실패`)) : null,
    route: route ? maskRoute(route) : null,
    count: 1,
    users: 0,
    firstSeen: "2026-11-07T00:00:00.000Z",
    lastSeen: "2026-11-07T00:00:00.000Z",
    link: "https://sentry.io/1/",
  };
}

describe("classify 외부 감시", () => {
  it("경로가 맞는 영역 이름을 쓰되 등급은 영역과 상관없이 P1이다", () => {
    expect(classify(TARGET, signal(null, "https://site.example/articles/1", "uptime.down"))).toEqual({
      area: "공개 조회",
      severity: "P1",
    });
  });

  it("맞는 영역이 없으면 전체·P1이다", () => {
    expect(classify(TARGET, signal(null, "https://site.example/api/health", "uptime.down"))).toEqual({
      area: "전체",
      severity: "P1",
    });
  });
});

describe("classify", () => {
  it.each([
    ["태그 일치", "auth", null, "인증", "P1"],
    ["태그 하위 경로", "admin/lectures", null, "어드민", "P3"],
    ["비슷한 태그는 다른 영역", "administrator", null, "기타", "P3"],
    ["route 일치", null, "GET /api/playback/[lectureId]", "강의 시청", "P1"],
    ["소스 경로", null, "app/api/playback/route.ts in GET", "강의 시청", "P1"],
    ["비슷한 route는 다른 영역", null, "/api/playback-old", "기타", "P3"],
    ["이름으로 고른 route", null, "/articles", "공개 조회", "P2"],
    ["단어 일부는 다른 영역", null, "/my-articles", "기타", "P3"],
    ["정규식 문자는 글자 그대로", null, "/api/a+b", "어드민", "P3"],
    ["일치하는 곳 없음", "unknown", "/unknown", "기타", "P3"],
    ["태그와 route 모두 없음", null, null, "기타", "P3"],
  ])("%s", (_name, tag, route, area, severity) => {
    expect(classify(TARGET, signal(tag, route))).toEqual({ area, severity });
  });

  it("설정의 앞쪽 영역이 먼저다", () => {
    expect(classify(TARGET, signal("auth", null)).area).toBe("인증");
  });

  it("운영 배포 실패는 전체 P1이다", () => {
    expect(classify(TARGET, signal(null, null, "deploy.failed"))).toEqual({ area: "전체", severity: "P1" });
  });
});

describe("escalate", () => {
  it.each([
    ["P3", 2, 0, "P3"],
    ["P3", 3, 0, "P2"],
    ["P2", 3, 0, "P1"],
    ["P1", 100, 100, "P1"],
    ["P3", 100, 100, "P2"],
    ["P3", 0, ESCALATION_USERS - 1, "P3"],
    ["P3", 0, ESCALATION_USERS, "P2"],
  ] as const)("%s, 증가 %i, 사용자 %i → %s", (base, increase, users, expected) => {
    expect(escalate(base, increase, users)).toBe(expected);
  });

  it("높은 등급을 고른다", () => {
    expect(higherOf("P1", "P2")).toBe("P1");
    expect(higherOf("P3", "P2")).toBe("P2");
  });
});

describe("initialBaseline", () => {
  const now = new Date("2026-11-07T01:00:00.000Z");

  it("방금 생긴 issue는 0부터 센다", () => {
    expect(initialBaseline(5, "2026-11-07T00:51:00.000Z", now)).toBe(0);
  });

  it("오래된 issue의 누적값은 증가분으로 치지 않는다", () => {
    expect(initialBaseline(500, "2026-11-01T00:00:00.000Z", now)).toBe(500);
  });
});

describe("updateSnapshots", () => {
  const at = (time: string) => new Date(`2026-11-07T${time}:00.000Z`);

  it("10분 전 값과의 차이를 돌려준다", () => {
    const first = updateSnapshots(baselineSnapshots(0, at("01:00")), 1, at("01:00"));
    expect(first.increase).toBe(1);

    const second = updateSnapshots(first.snapshots, 2, at("01:05"));
    expect(second.increase).toBe(2);

    const third = updateSnapshots(second.snapshots, 6, at("01:10"));
    expect(third.increase).toBe(5);

    const fourth = updateSnapshots(third.snapshots, 6, at("01:15"));
    expect(fourth.increase).toBe(4);

    const fifth = updateSnapshots(fourth.snapshots, 6, at("01:20"));
    expect(fifth.increase).toBe(0);
  });

  it("같은 버킷을 다시 읽어도 두 번 더하지 않는다", () => {
    const first = updateSnapshots(baselineSnapshots(10, at("01:00")), 12, at("01:01"));
    const second = updateSnapshots(first.snapshots, 12, at("01:02"));
    const third = updateSnapshots(second.snapshots, 12, at("01:04"));
    expect([first.increase, second.increase, third.increase]).toEqual([2, 2, 2]);
    expect(Object.keys(third.snapshots)).toHaveLength(2);
  });

  it("같은 버킷에 더 작은 값이 와도 큰 값을 유지한다", () => {
    const first = updateSnapshots(baselineSnapshots(0, at("01:00")), 6, at("01:01"));
    const second = updateSnapshots(first.snapshots, 3, at("01:02"));
    expect(second.snapshots["2026-11-07T01:00:00.000Z"]).toBe(6);
    expect(second.increase).toBe(6);
  });

  it("누적값이 줄어도 음수가 되지 않는다", () => {
    expect(updateSnapshots(baselineSnapshots(10, at("01:00")), 3, at("01:00")).increase).toBe(0);
  });

  it("쌓이는 값은 기준값 하나와 최근 버킷만 남는다", () => {
    let snapshots = baselineSnapshots(0, at("01:00"));
    for (const time of ["01:00", "01:05", "01:10", "01:15", "01:20", "01:25", "01:30"]) {
      ({ snapshots } = updateSnapshots(snapshots, 1, at(time)));
    }
    expect(Object.keys(snapshots)).toEqual([
      "2026-11-07T01:20:00.000Z",
      "2026-11-07T01:25:00.000Z",
      "2026-11-07T01:30:00.000Z",
    ]);
  });

  it("실행이 오래 빠져도 마지막 기준값으로 계산한다", () => {
    const before = updateSnapshots(baselineSnapshots(0, at("01:00")), 5, at("01:00"));
    expect(updateSnapshots(before.snapshots, 9, at("03:00")).increase).toBe(4);
  });
});

describe("windowIncrease", () => {
  it("시각 순서로 첫 값과 마지막 값의 차이를 돌려준다", () => {
    expect(
      windowIncrease({
        "2026-11-07T01:05:00.000Z": 4,
        "2026-11-07T00:55:00.000Z": 1,
        "2026-11-07T01:00:00.000Z": 2,
      }),
    ).toBe(3);
  });

  it("버킷이 없거나 하나면 0이다", () => {
    expect(windowIncrease({})).toBe(0);
    expect(windowIncrease({ "2026-11-07T01:00:00.000Z": 5 })).toBe(0);
  });
});
