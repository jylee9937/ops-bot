import { describe, expect, it } from "vitest";
import {
  maskException,
  maskFrame,
  maskLogMessage,
  maskRoute,
  tagOf,
  type MaskedText,
} from "./mask";
import type { Signal } from "./signal";

describe("maskLogMessage", () => {
  it.each([
    ["콜론 뒤 객체", '[articles] 공개 목록 조회 실패: {"email":"kim@example.com"}', "[articles] 공개 목록 조회 실패"],
    ["콜론 뒤 이름", "[auth] 로그인 실패: 홍길동", "[auth] 로그인 실패"],
    ["전각 콜론", "[auth] 로그인 실패：홍길동", "[auth] 로그인 실패"],
    ["Postgres DETAIL 줄", "[inquiry] 저장 실패\nDETAIL: Key (email)=(kim@example.com) already exists.", "[inquiry] 저장 실패"],
    ["앞쪽 빈 줄", "\n\n[cron] 작업 실패", "[cron] 작업 실패"],
    ["태그 뒤 콜론", "[auth]: 로그인 실패", "[auth]"],
    ["예외 문자열", "TypeError: Cannot read properties of undefined", "TypeError"],
    ["빈 값", "", "(메시지 없음)"],
    ["공백만", "   \n  ", "(메시지 없음)"],
  ])("%s", (_name, raw, expected) => {
    expect(maskLogMessage(raw)).toBe(expected);
  });

  it.each([
    ["이메일", "문의 kim.lee+a@example.co.kr 처리 실패", "문의 [이메일] 처리 실패"],
    ["휴대전화 하이픈", "010-1234-5678 전송 실패", "[전화번호] 전송 실패"],
    ["휴대전화 붙임", "01012345678 전송 실패", "[전화번호] 전송 실패"],
    ["휴대전화 국가번호", "+82 10 1234 5678 전송 실패", "[전화번호] 전송 실패"],
    ["유선전화", "02-123-4567 전송 실패", "[전화번호] 전송 실패"],
    ["10자리 숫자", "주문 1234567890 실패", "주문 [숫자] 실패"],
    ["계좌번호", "입금 110-123-456789 실패", "입금 [숫자] 실패"],
    ["보이지 않는 글자로 쪼갠 번호", "010\u200b1234\u200b5678 전송 실패", "[전화번호] 전송 실패"],
    ["9자리 이하 숫자는 남김", "재시도 123456789 실패", "재시도 123456789 실패"],
  ])("정규식: %s", (_name, raw, expected) => {
    expect(maskLogMessage(raw)).toBe(expected);
  });

  it("200자로 자른다", () => {
    expect(Array.from(maskLogMessage("가".repeat(300)))).toHaveLength(200);
  });

  it("글자를 반으로 쪼개지 않는다", () => {
    const result = maskLogMessage("😀".repeat(300));
    expect(Array.from(result)).toHaveLength(200);
    expect(result.endsWith("😀")).toBe(true);
  });

  it("경계에 걸린 이메일도 일부가 남지 않는다", () => {
    const result = maskLogMessage(`${"가".repeat(190)} kim.lee@example.com 실패`);
    expect(result).not.toContain("kim");
    expect(result).toContain("[이메일]");
  });

  it("아주 긴 입력도 빠르게 처리한다", () => {
    const started = performance.now();
    maskLogMessage("a.".repeat(1_000_000));
    maskLogMessage("1-".repeat(1_000_000));
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("maskException", () => {
  it.each([
    ["메시지 버림", "TypeError", "Cannot read properties of undefined", "TypeError"],
    ["태그 없는 자유 텍스트", "Error", "홍길동 님의 문의 저장 실패", "Error"],
    ["태그 있는 고정 문구", "Error", "[auth] 로그인 실패: kim@example.com", "[auth] 로그인 실패 (Error)"],
    ["값 없음", "RangeError", null, "RangeError"],
    ["식별자가 아닌 타입", "<!channel> 긴급", null, "알 수 없는 예외"],
  ])("%s", (_name, type, value, expected) => {
    expect(maskException(type, value)).toBe(expected);
  });
});

describe("maskRoute", () => {
  it.each([
    ["쿼리", "GET /api/playback?token=abc&email=kim@example.com", "GET /api/playback"],
    ["주소와 해시", "https://site.example/a/b?x=1#c", "/a/b"],
    ["주소만", "https://site.example", "/"],
    ["경로 속 이메일", "/users/kim@example.com/edit", "/users/[이메일]/edit"],
    ["소스 위치", "app/api/playback/route.ts in GET", "app/api/playback/route.ts in GET"],
  ])("%s", (_name, raw, expected) => {
    expect(maskRoute(raw)).toBe(expected);
  });
});

describe("maskFrame", () => {
  it("파일·함수·줄만 남긴다", () => {
    const frame = {
      filename: "app:///_next/server/app.js?dpl=abc",
      function: "handler",
      line: 42,
      context: [[42, "const email = 'kim@example.com'"]],
      vars: { email: "kim@example.com" },
    };
    expect(maskFrame(frame)).toEqual({
      filename: "/_next/server/app.js",
      function: "handler",
      line: 42,
    });
  });

  it("패키지 경로를 이메일로 오인하지 않는다", () => {
    const filename = "node_modules/.pnpm/next@16.4.5_react@19.2.0/node_modules/@sentry/core/index.js";
    expect(maskFrame({ filename }).filename).toBe(filename);
  });

  it.each([
    ["없는 줄", null],
    ["0", 0],
    ["음수", -1],
    ["소수", 1.5],
  ])("줄 번호가 %s이면 null", (_name, line) => {
    expect(maskFrame({ filename: "a.ts", line }).line).toBeNull();
  });

  it("파일이 없어도 자리를 채운다", () => {
    expect(maskFrame({}).filename).toBe("(파일 없음)");
  });
});

describe("tagOf", () => {
  it.each([
    ["[articles] 조회 실패", "articles"],
    ["[admin/lectures] 저장 실패", "admin/lectures"],
    ["조회 실패", null],
    ["[홍길동] 조회 실패", null],
  ])("%s", (raw, expected) => {
    expect(tagOf(maskLogMessage(raw))).toBe(expected);
  });
});

describe("MaskedText 타입", () => {
  it("원문 문자열을 컴파일에서 거부한다", () => {
    // @ts-expect-error 원문 문자열은 MaskedText가 아니다
    const text: MaskedText = "원문";
    // @ts-expect-error Signal에도 원문을 넣을 수 없다
    const signal: Pick<Signal, "title"> = { title: "원문" };
    expect([text, signal.title]).toEqual(["원문", "원문"]);
  });
});
