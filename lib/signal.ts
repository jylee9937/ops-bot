import type { MaskedText } from "./mask";

export type SignalSource = "sentry" | "vercel" | "uptimerobot";

export type SignalKind =
  | "issue.new"
  | "issue.regressed"
  | "issue.ongoing"
  | "issue.resolved"
  | "issue.ignored"
  | "deploy.failed"
  // 외부 감시(UptimeRobot)가 다운으로 본 감시. 다시 UP이 되면 collect가 해결 처리한다.
  | "uptime.down";

/** 수집기가 외부 응답을 정규화한 결과. 글자는 모두 입구에서 마스킹됐다. */
export type Signal = {
  target: string;
  source: SignalSource;
  kind: SignalKind;
  // (target, fingerprint)가 incident 하나다.
  fingerprint: string;
  // 원래 도구에서 쓰는 id. 최신 이벤트와 상태를 다시 읽을 때 쓴다.
  sourceId: string;
  title: MaskedText;
  tag: MaskedText | null;
  route: MaskedText | null;
  // 누적값이다. 등급 상승은 incidents가 구간별 증가분으로 계산한다.
  count: number;
  users: number;
  firstSeen: string;
  lastSeen: string;
  // 세부 내용은 원래 도구에서 본다.
  link: string;
};

export type Deploy = {
  target: string;
  deploymentId: string;
  sha: string | null;
  state: string;
  createdAt: string;
  // READY가 된 시각. ERROR면 실패한 시각이다.
  readyAt: string | null;
};

export type SourceResult = {
  signals: Signal[];
  // 형식이 달라 건너뛴 항목 수
  skipped: number;
  // 다 읽지 못했으면 이전 커서를 돌려준다. 다음 실행이 같은 구간을 다시 읽는다.
  nextCursor: string | null;
};
