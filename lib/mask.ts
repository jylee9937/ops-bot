declare const masked: unique symbol;

/**
 * 입구에서 허용 목록을 통과한 글자. 이 파일 밖에서는 만들 수 없으므로
 * 저장·Claude·Slack이 원문 문자열을 받는 코드는 컴파일되지 않는다.
 * 개인정보를 걷어 낸 글자일 뿐 믿을 수 있는 글자는 아니다. Sentry 이벤트는 위조될 수 있으니
 * Slack·Claude로 보낼 때 따로 막는다.
 */
export type MaskedText = string & { readonly [masked]: true };

export type MaskedFrame = {
  filename: MaskedText;
  function: MaskedText | null;
  line: number | null;
};

const MAX_LENGTH = 200;
// 정규식을 돌리기 전에 입력 크기를 제한한다.
const MAX_INPUT = 2_000;

// 태그는 코드에 적는 값이라 영문 식별자만 인정한다. 사람 이름이 태그로 통과하지 않게 한다.
const TAG = /^\[[A-Za-z0-9_\-/.]{1,40}\]/;
const EXCEPTION_TYPE = /^[A-Za-z_$][\w$.]{0,79}$/;
const LINE_BREAK = /\r\n|[\r\n\u0085\u2028\u2029]/;
const URL_ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i;

const EMAIL =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const MOBILE = /(?<!\d)(?:\+?82[-.\s]?)?0?1[016789][-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)/g;
const LANDLINE = /(?<!\d)0\d{1,2}[-.\s]\d{3,4}[-.\s]\d{4}(?!\d)/g;
const LONG_NUMBER = /(?<!\d)\d(?:[-.\s]?\d){9,}(?!\d)/g;

function firstLine(raw: string): string {
  return raw.slice(0, MAX_INPUT).trimStart().split(LINE_BREAK, 1)[0];
}

function beforeColon(text: string): string {
  return text.split(/[:：]/, 1)[0];
}

function withoutUrlParts(text: string): string {
  return text.replace(URL_ORIGIN, "").split(/[?#]/, 1)[0];
}

// 정규식을 먼저 돌리고 나서 자른다. 반대로 하면 잘린 이메일이 정규식을 빠져나간다.
function finish(text: string, fallback: string): MaskedText {
  const scrubbed = text
    .replace(/\p{Cf}/gu, "")
    .replace(/\p{Cc}/gu, " ")
    .replace(EMAIL, "[이메일]")
    .replace(MOBILE, "[전화번호]")
    .replace(LANDLINE, "[전화번호]")
    .replace(LONG_NUMBER, "[숫자]")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(scrubbed || fallback)
    .slice(0, MAX_LENGTH)
    .join("")
    .trimEnd() as MaskedText;
}

/** 로그 메시지에서 `[태그]`와 콜론 앞 고정 문구만 남긴다. 콜론 뒤의 변수는 버린다. */
export function maskLogMessage(raw: string): MaskedText {
  return finish(beforeColon(firstLine(raw)), "(메시지 없음)");
}

/**
 * 예외는 타입을 남기고, 메시지는 `[태그]`로 시작할 때만 고정 문구를 함께 남긴다.
 * 태그 없는 예외 메시지는 코드 문구인지 변수가 섞였는지 구분할 수 없어 버린다.
 */
export function maskException(type: string, value?: string | null): MaskedText {
  const name = EXCEPTION_TYPE.test(type) ? type : "알 수 없는 예외";
  const message = value ? beforeColon(firstLine(value)).trim() : "";
  return finish(TAG.test(message) ? `${message} (${name})` : name, name);
}

/** route에서 사이트 주소와 쿼리·해시를 뗀다. */
export function maskRoute(raw: string): MaskedText {
  return finish(withoutUrlParts(firstLine(raw)), "/");
}

/** 스택 프레임에서 파일·함수·줄만 남긴다. 소스 코드와 변수 값은 받지 않는다. */
export function maskFrame(frame: {
  filename?: string | null;
  function?: string | null;
  line?: number | null;
}): MaskedFrame {
  const { line } = frame;
  return {
    filename: finish(withoutUrlParts(firstLine(frame.filename ?? "")), "(파일 없음)"),
    function: frame.function ? finish(firstLine(frame.function), "(함수 없음)") : null,
    line: line != null && Number.isInteger(line) && line > 0 ? line : null,
  };
}

/** 마스킹된 글자에서 `[태그]`의 이름을 꺼낸다. 영역 판단에 쓴다. */
export function tagOf(text: MaskedText): MaskedText | null {
  const match = TAG.exec(text);
  return match ? (match[0].slice(1, -1) as MaskedText) : null;
}
