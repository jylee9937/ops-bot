import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, migrate } from "./db";

const NOW = "2026-11-06T00:00:00.000Z";

const insertIncident = (db: Client) =>
  db.execute({
    sql: `INSERT INTO incidents (target, fingerprint, severity, area, title, first_seen, last_seen)
          VALUES ('site-a', 'fp', 'P1', '인증', '[auth] 로그인 서비스 실패', ?, ?)`,
    args: [NOW, NOW],
  });

describe("migrate", () => {
  let dir: string;
  let db: Client;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ops-bot-db-"));
    db = createDb(`file:${join(dir, "test.db")}`, "");
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("빈 DB에 핵심 표를 만들고, 다시 실행해도 아무것도 하지 않는다", async () => {
    expect(await migrate(db)).toEqual([1, 2]);
    expect(await migrate(db)).toEqual([]);

    const { rows } = await db.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    expect(rows.map((row) => row.name)).toEqual(
      expect.arrayContaining(["cursors", "deploys", "incidents", "locks", "mutes"]),
    );
  });

  it("같은 사이트의 같은 지문은 incident 하나만 허용한다", async () => {
    await migrate(db);
    await insertIncident(db);

    await expect(insertIncident(db)).rejects.toThrow(/UNIQUE/);
  });

  it("incident 근거는 JSON만 저장한다", async () => {
    await migrate(db);
    await insertIncident(db);

    await expect(
      db.execute("UPDATE incidents SET evidence = 'not json'"),
    ).rejects.toThrow(/CHECK/);
  });

  it.each([
    ["없는 등급", "UPDATE incidents SET severity = 'P9'"],
    ["없는 상태", "UPDATE incidents SET status = 'muted'"],
  ])("거부한다: %s", async (_label, sql) => {
    await migrate(db);
    await insertIncident(db);

    await expect(db.execute(sql)).rejects.toThrow(/CHECK/);
  });
});

describe("createDb", () => {
  it("URL이 없으면 멈춘다", () => {
    expect(() => createDb("", "")).toThrow("TURSO_DATABASE_URL");
  });
});
