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
  ];

export function createDb(
  url = process.env.TURSO_DATABASE_URL,
  authToken = process.env.TURSO_AUTH_TOKEN,
): Client {
  if (!url) throw new Error("TURSO_DATABASE_URL이 비어 있습니다");
  return createClient({ url, authToken: authToken || undefined });
}

/** 적용하지 않은 버전만 순서대로 적용한다. 여러 번 실행해도 안전하다. */
export async function migrate(db: Client): Promise<number[]> {
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
    if (applied.has(version)) continue;
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
