import { createClient, type Client } from "@libsql/client";

// 시각은 전부 UTC ISO-8601 문자열로 저장한다.
const MIGRATIONS: readonly { version: number; statements: readonly string[] }[] =
  [
    {
      version: 1,
      statements: [
        `CREATE TABLE cursors (
          target TEXT NOT NULL,
          source TEXT NOT NULL,
          cursor TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (target, source)
        )`,
        `CREATE TABLE incidents (
          id INTEGER PRIMARY KEY,
          target TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          episode INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
          severity TEXT NOT NULL CHECK (severity IN ('P1', 'P2', 'P3')),
          area TEXT NOT NULL,
          title TEXT NOT NULL,
          evidence TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(evidence)),
          first_seen TEXT NOT NULL,
          last_seen TEXT NOT NULL,
          notified_at TEXT,
          slack_ts TEXT,
          resolved_at TEXT,
          UNIQUE (target, fingerprint)
        )`,
        `CREATE INDEX incidents_unnotified ON incidents (target, severity)
          WHERE notified_at IS NULL`,
        `CREATE INDEX incidents_last_seen ON incidents (last_seen)`,
        `CREATE TABLE deploys (
          deployment_id TEXT PRIMARY KEY,
          target TEXT NOT NULL,
          sha TEXT,
          state TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`,
        `CREATE INDEX deploys_target_created ON deploys (target, created_at)`,
        `CREATE TABLE mutes (
          target TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          until TEXT NOT NULL,
          PRIMARY KEY (target, fingerprint)
        )`,
        `CREATE TABLE locks (
          name TEXT PRIMARY KEY,
          holder TEXT NOT NULL,
          expires_at TEXT NOT NULL
        )`,
      ],
    },
    {
      version: 2,
      statements: [
        // 알림을 기다리기 시작한 시각. heartbeat의 '미전송 최장 대기'를 잰다.
        `ALTER TABLE incidents ADD COLUMN pending_since TEXT`,
        // 전송 중 표시. 전송 도중 함수가 죽어도 시간이 지나면 다시 보낸다.
        `ALTER TABLE incidents ADD COLUMN notify_claimed_at TEXT`,
      ],
    },
    {
      version: 3,
      statements: [
        // 읽은 뒤 다른 실행이 먼저 썼는지 확인한다. 썼으면 다시 읽고 판단한다.
        `ALTER TABLE incidents ADD COLUMN version INTEGER NOT NULL DEFAULT 0`,
        // 전송을 시작한 실행의 표. 그 실행만 완료·취소할 수 있다.
        `ALTER TABLE incidents ADD COLUMN notify_claim TEXT`,
        // v1 시절 미전송 행은 대기 시작 시각이 없다. 적용 시각부터 잰다.
        `UPDATE incidents SET pending_since = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE status = 'open' AND notified_at IS NULL AND pending_since IS NULL`,
        // 배포 연관은 공개된 시각으로 판단한다. 빌드 시간이 길어도 놓치지 않게.
        `ALTER TABLE deploys ADD COLUMN ready_at TEXT`,
      ],
    },
    {
      version: 4,
      statements: [
        // 상세 알림을 보낼 때 만든 Claude 요약·스택·같은 시각 다른 사이트. 버튼을 누른 뒤 다시 그릴 때도 쓴다.
        `ALTER TABLE incidents ADD COLUMN analysis TEXT`,
        // Claude 하루 호출 수(KST 날짜). 실행이 달라도 함께 센다.
        `CREATE TABLE analysis_usage (
          day TEXT PRIMARY KEY,
          calls INTEGER NOT NULL
        )`,
      ],
    },
    {
      version: 5,
      statements: [
        // collect 실행마다 결과 한 줄. /ops status가 마지막 수집·heartbeat를 보여 준다. incident 내용은 담지 않는다.
        `CREATE TABLE collect_runs (
          id INTEGER PRIMARY KEY,
          caller TEXT NOT NULL CHECK (caller IN ('cron', 'slack')),
          started_at TEXT NOT NULL,
          finished_at TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('done', 'locked', 'failed')),
          steps_ok INTEGER NOT NULL,
          steps_total INTEGER NOT NULL,
          heartbeat TEXT NOT NULL CHECK (heartbeat IN ('sent', 'skipped', 'failed', 'disabled'))
        )`,
        `CREATE INDEX collect_runs_caller_started ON collect_runs (caller, started_at)`,
        // Slack 명령의 하루(KST) 사용 횟수. 알림 요약(analysis_usage)과 따로 센다.
        `CREATE TABLE command_usage (
          day TEXT NOT NULL,
          command TEXT NOT NULL,
          calls INTEGER NOT NULL,
          PRIMARY KEY (day, command)
        )`,
        // 실행한 Slack 명령 요청(서명). 같은 요청이 다시 오면 실행하지 않는다. 서명은 5분만 유효하다.
        `CREATE TABLE slack_requests (
          id TEXT PRIMARY KEY,
          seen_at TEXT NOT NULL
        )`,
      ],
    },
  ];

export function createDb(
  url = process.env.TURSO_DATABASE_URL,
  authToken = process.env.TURSO_AUTH_TOKEN,
): Client {
  if (!url) throw new Error("TURSO_DATABASE_URL이 비어 있습니다");
  return createClient({ url, authToken: authToken || undefined });
}

/** 적용하지 않은 버전만 순서대로 적용한다. 여러 번 실행해도 안전하다. `upTo`는 테스트용이다. */
export async function migrate(db: Client, upTo = Number.POSITIVE_INFINITY): Promise<number[]> {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`,
  );
  const { rows } = await db.execute("SELECT version FROM schema_migrations");
  const applied = new Set(rows.map((row) => Number(row.version)));

  const newlyApplied: number[] = [];
  for (const { version, statements } of MIGRATIONS) {
    if (applied.has(version) || version > upTo) continue;
    await db.batch(
      [
        ...statements,
        {
          sql: "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
          args: [version, new Date().toISOString()],
        },
      ],
      "write",
    );
    newlyApplied.push(version);
  }
  return newlyApplied;
}
