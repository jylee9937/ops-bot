import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { createDb, migrate } from "../db";

/** 테스트마다 새 SQLite 파일을 만들고 스키마를 적용한다. `migrated: false`면 빈 DB로 둔다. */
export async function createTestDb({ migrated = true }: { migrated?: boolean } = {}): Promise<{
  db: Client;
  url: string;
  // 같은 파일에 새 연결을 연다(동시 실행 재현용). cleanup이 함께 닫는다.
  connect: () => Client;
  cleanup: () => void;
}> {
  const dir = mkdtempSync(join(tmpdir(), "ops-bot-test-"));
  const url = `file:${join(dir, "test.db")}`;
  const db = createDb(url, "");
  if (migrated) await migrate(db);
  const extra: Client[] = [];
  return {
    db,
    url,
    connect: () => {
      const client = createDb(url, "");
      extra.push(client);
      return client;
    },
    cleanup: () => {
      for (const client of extra) client.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
