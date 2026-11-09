import type { Client, InStatement, Row } from "@libsql/client";
import { createDb } from "./db";
import { maskedFromStore, type MaskedText } from "./mask";
import {
  baselineSnapshots,
  classify,
  escalate,
  higherOf,
  initialBaseline,
  isHigher,
  updateSnapshots,
  type CountSnapshots,
} from "./rules";
import type { Deploy, Signal, SignalKind, SignalSource } from "./signal";
import type { Severity, Target } from "./targets";

const DEPLOY_RELATION_MS = 30 * 60_000;
const CORRELATION_WINDOW_MS = 5 * 60_000;
// Vercel 함수 제한 시간보다 길다. 이 시간이 지난 전송 표시는 함수가 죽은 것으로 본다.
const CLAIM_TTL_MS = 10 * 60_000;
const DELIVERY_OVERDUE_MS = 15 * 60_000;
const LOCK_TTL_MS = 5 * 60_000;
const RETENTION_MS = 180 * 24 * 60 * 60_000;
const MAX_INGEST_ATTEMPTS = 3;

// 이 상태가 된 배포는 늦게 도착한 과거 상태로 되돌리지 않는다.
const FINAL_DEPLOY_STATES = "'READY', 'ERROR', 'CANCELED', 'DELETED'";
// 알림을 다시 보내야 하거나 보낼 필요가 없어지면 진행 중인 전송의 표를 무효로 만든다.
const CLEAR_CLAIM = "notify_claimed_at = NULL, notify_claim = NULL";

/** route가 쓰는 연결. 표는 계속 이 파일의 함수로만 읽고 쓴다. */
export function openDb(): Client {
  return createDb();
}

export type RelatedDeploy = {
  deploymentId: string;
  sha: string | null;
  createdAt: string;
  readyAt: string | null;
};

export type Evidence = {
  source: SignalSource;
  sourceId: string;
  kind: SignalKind;
  tag: MaskedText | null;
  route: MaskedText | null;
  link: string;
  count: number;
  users: number;
  snapshots: CountSnapshots;
  relatedDeploy: RelatedDeploy | null;
};

export type Incident = {
  id: number;
  target: string;
  fingerprint: string;
  episode: number;
  status: "open" | "resolved";
  severity: Severity;
  area: string;
  title: MaskedText;
  evidence: Evidence;
  firstSeen: string;
  lastSeen: string;
  notifiedAt: string | null;
  slackTs: string | null;
  resolvedAt: string | null;
  pendingSince: string | null;
  version: number;
};

export type IngestSummary = {
  created: number;
  updated: number;
  reopened: number;
  escalated: number;
  resolved: number;
  ignored: number;
};

type Plan = {
  signal: Signal;
  // 버전을 확인하는 쓰기. 영향받은 행이 없으면 다른 실행이 먼저 쓴 것이다.
  statement: InStatement | null;
  outcomes: (keyof IngestSummary)[];
};

function nullableString(value: Row[string]): string | null {
  return value === null ? null : String(value);
}

function toIncident(row: Row): Incident {
  return {
    id: Number(row.id),
    target: String(row.target),
    fingerprint: String(row.fingerprint),
    episode: Number(row.episode),
    status: String(row.status) as Incident["status"],
    severity: String(row.severity) as Severity,
    area: String(row.area),
    title: maskedFromStore(String(row.title)),
    evidence: JSON.parse(String(row.evidence)),
    firstSeen: String(row.first_seen),
    lastSeen: String(row.last_seen),
    notifiedAt: nullableString(row.notified_at),
    slackTs: nullableString(row.slack_ts),
    resolvedAt: nullableString(row.resolved_at),
    pendingSince: nullableString(row.pending_since),
    version: Number(row.version),
  };
}

function isoBefore(now: Date, ms: number): string {
  return new Date(now.getTime() - ms).toISOString();
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

function latestPerFingerprint(signals: readonly Signal[]): Signal[] {
  const latest = new Map<string, Signal>();
  for (const signal of signals) {
    const seen = latest.get(signal.fingerprint);
    if (!seen || signal.lastSeen >= seen.lastSeen) latest.set(signal.fingerprint, signal);
  }
  return [...latest.values()];
}

function isClosedInSource(kind: SignalKind): boolean {
  return kind === "issue.resolved" || kind === "issue.ignored";
}

function evidenceOf(
  signal: Signal,
  { count, users }: { count: number; users: number },
  snapshots: CountSnapshots,
  relatedDeploy: RelatedDeploy | null,
): Evidence {
  return {
    source: signal.source,
    sourceId: signal.sourceId,
    kind: signal.kind,
    tag: signal.tag,
    route: signal.route,
    link: signal.link,
    count,
    users,
    snapshots,
    relatedDeploy,
  };
}

function findRelatedDeploy(
  deploys: readonly RelatedDeploy[],
  signal: Signal,
  startedAt: string,
): RelatedDeploy | null {
  if (signal.source !== "sentry") return null;
  const start = Date.parse(startedAt);
  return (
    deploys.find((deploy) => {
      const live = Date.parse(deploy.readyAt ?? deploy.createdAt);
      return live <= start && start - live <= DEPLOY_RELATION_MS;
    }) ?? null
  );
}

/**
 * 신호를 규칙으로 판단해 incident에 반영한다. 알릴 것은 notified_at이 비어 있는 행이다.
 * 같은 구간을 다시 읽어도 결과가 같다. 저장되는 글자는 모두 MaskedText다.
 * 읽은 뒤 다른 실행이 먼저 쓴 incident는 다시 읽어 판단한다.
 */
export async function ingest(
  db: Client,
  target: Target,
  signals: readonly Signal[],
  now: Date,
): Promise<IngestSummary> {
  const summary: IngestSummary = {
    created: 0,
    updated: 0,
    reopened: 0,
    escalated: 0,
    resolved: 0,
    ignored: 0,
  };

  let remaining = latestPerFingerprint(signals);
  for (let attempt = 1; remaining.length > 0; attempt++) {
    if (attempt > MAX_INGEST_ATTEMPTS) {
      throw new Error(`incident 갱신이 ${MAX_INGEST_ATTEMPTS}번 연속 충돌했습니다`);
    }

    const plans = await planIngest(db, target, remaining, now);
    const statements = plans.flatMap((plan) => (plan.statement ? [plan.statement] : []));
    const results = statements.length > 0 ? await db.batch(statements, "write") : [];

    remaining = [];
    let index = 0;
    for (const plan of plans) {
      if (plan.statement && results[index++].rowsAffected === 0) {
        remaining.push(plan.signal);
        continue;
      }
      for (const outcome of plan.outcomes) summary[outcome]++;
    }
  }
  return summary;
}

async function planIngest(
  db: Client,
  target: Target,
  signals: readonly Signal[],
  now: Date,
): Promise<Plan[]> {
  const fingerprints = signals.map((signal) => signal.fingerprint);

  const [incidents, mutes, recentDeploys] = await Promise.all([
    db.execute({
      sql: `SELECT * FROM incidents WHERE target = ? AND fingerprint IN (${placeholders(fingerprints)})`,
      args: [target.id, ...fingerprints],
    }),
    db.execute({
      sql: `SELECT fingerprint, until FROM mutes WHERE target = ? AND fingerprint IN (${placeholders(fingerprints)})`,
      args: [target.id, ...fingerprints],
    }),
    db.execute({
      sql: `SELECT deployment_id, sha, created_at, ready_at FROM deploys
            WHERE target = ? AND state = 'READY'
            ORDER BY COALESCE(ready_at, created_at) DESC LIMIT 50`,
      args: [target.id],
    }),
  ]);

  const rows = new Map(incidents.rows.map((row) => [String(row.fingerprint), toIncident(row)]));
  const muteUntil = new Map(mutes.rows.map((row) => [String(row.fingerprint), String(row.until)]));
  const deploys: RelatedDeploy[] = recentDeploys.rows.map((row) => ({
    deploymentId: String(row.deployment_id),
    sha: nullableString(row.sha),
    createdAt: String(row.created_at),
    readyAt: nullableString(row.ready_at),
  }));

  return signals.map((signal) =>
    planSignal(target, signal, rows.get(signal.fingerprint), muteUntil.get(signal.fingerprint), deploys, now),
  );
}

function planSignal(
  target: Target,
  signal: Signal,
  row: Incident | undefined,
  until: string | undefined,
  deploys: readonly RelatedDeploy[],
  now: Date,
): Plan {
  const nowIso = now.toISOString();
  const skip = (): Plan => ({ signal, statement: null, outcomes: ["ignored"] });

  // 이미 더 최근 발생을 저장했다. 늦게 도착한 옛 응답이다.
  if (row && signal.lastSeen < row.lastSeen) return skip();

  if (isClosedInSource(signal.kind)) {
    if (row?.status !== "open") return skip();
    return {
      signal,
      statement: {
        sql: `UPDATE incidents
              SET status = 'resolved', resolved_at = ?, pending_since = NULL, ${CLEAR_CLAIM},
                  version = version + 1
              WHERE id = ? AND version = ?`,
        args: [nowIso, row.id, row.version],
      },
      outcomes: ["resolved"],
    };
  }

  // 해결 전에 일어난 일을 겹쳐 읽었을 뿐이다.
  if (row?.status === "resolved" && signal.lastSeen <= (row.resolvedAt ?? "")) return skip();

  const isMuted = until !== undefined && signal.lastSeen <= until;
  const { area, severity: base } = classify(target, signal);

  if (!row) {
    const { snapshots, increase } = updateSnapshots(
      baselineSnapshots(initialBaseline(signal.count, signal.firstSeen, now), now),
      signal.count,
      now,
    );
    return {
      signal,
      statement: {
        sql: `INSERT INTO incidents
                (target, fingerprint, severity, area, title, evidence, first_seen, last_seen,
                 notified_at, pending_since, version)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
              ON CONFLICT (target, fingerprint) DO NOTHING`,
        args: [
          target.id,
          signal.fingerprint,
          escalate(base, increase, signal.users),
          area,
          signal.title,
          JSON.stringify(
            evidenceOf(signal, signal, snapshots, findRelatedDeploy(deploys, signal, signal.firstSeen)),
          ),
          signal.firstSeen,
          signal.lastSeen,
          // 음소거 중에 생긴 incident는 알리지 않고 전달된 것으로 둔다.
          isMuted ? nowIso : null,
          isMuted ? null : nowIso,
        ],
      },
      outcomes: ["created"],
    };
  }

  if (row.status === "resolved") {
    const { snapshots, increase } = updateSnapshots(
      baselineSnapshots(row.evidence.count, now),
      signal.count,
      now,
    );
    return {
      signal,
      statement: {
        sql: `UPDATE incidents
              SET status = 'open', episode = episode + 1, severity = ?, area = ?, title = ?,
                  evidence = ?, last_seen = ?, resolved_at = NULL, slack_ts = NULL, ${CLEAR_CLAIM},
                  notified_at = ?, pending_since = ?, version = version + 1
              WHERE id = ? AND version = ?`,
        args: [
          escalate(base, increase, signal.users),
          area,
          signal.title,
          JSON.stringify(
            evidenceOf(signal, signal, snapshots, findRelatedDeploy(deploys, signal, signal.lastSeen)),
          ),
          signal.lastSeen,
          isMuted ? nowIso : null,
          isMuted ? null : nowIso,
          row.id,
          row.version,
        ],
      },
      outcomes: ["reopened"],
    };
  }

  const totals = {
    count: Math.max(row.evidence.count, signal.count),
    users: Math.max(row.evidence.users, signal.users),
  };
  const { snapshots, increase } = updateSnapshots(row.evidence.snapshots, totals.count, now);
  const severity = higherOf(row.severity, escalate(base, increase, totals.users));
  const rose = isHigher(severity, row.severity);
  // 음소거가 끝난 뒤 처음 들어온 발생이면 한 번 다시 알린다.
  const isFirstAfterMute = until !== undefined && row.lastSeen <= until && !isMuted;
  const needsAlert = (rose && !isMuted) || isFirstAfterMute;

  return {
    signal,
    statement: {
      // 알릴 일이 없으면 전달 상태를 건드리지 않는다.
      sql: `UPDATE incidents
            SET severity = ?, area = ?, title = ?, evidence = ?,
                first_seen = MIN(first_seen, ?), last_seen = MAX(last_seen, ?),
                version = version + 1
                ${needsAlert ? `, notified_at = NULL, ${CLEAR_CLAIM}, pending_since = COALESCE(pending_since, ?)` : ""}
            WHERE id = ? AND version = ?`,
      args: [
        severity,
        area,
        signal.title,
        JSON.stringify(evidenceOf(signal, totals, snapshots, row.evidence.relatedDeploy)),
        signal.firstSeen,
        signal.lastSeen,
        ...(needsAlert ? [nowIso] : []),
        row.id,
        row.version,
      ],
    },
    outcomes: rose ? ["updated", "escalated"] : ["updated"],
  };
}

/** ops-bot 상태만 바꾼다. Sentry에는 쓰지 않는다. 바뀌었으면 true. */
export async function resolveIncident(
  db: Client,
  targetId: string,
  fingerprint: string,
  now: Date,
): Promise<boolean> {
  const { rowsAffected } = await db.execute({
    sql: `UPDATE incidents
          SET status = 'resolved', resolved_at = ?, pending_since = NULL, ${CLEAR_CLAIM},
              version = version + 1
          WHERE target = ? AND fingerprint = ? AND status = 'open'`,
    args: [now.toISOString(), targetId, fingerprint],
  });
  return rowsAffected === 1;
}

/** 음소거하고, 아직 보내지 않은 알림도 함께 멈춘다. */
export async function muteIncident(
  db: Client,
  targetId: string,
  fingerprint: string,
  until: Date,
  now: Date,
): Promise<void> {
  await db.batch(
    [
      {
        sql: `INSERT INTO mutes (target, fingerprint, until) VALUES (?, ?, ?)
              ON CONFLICT (target, fingerprint) DO UPDATE SET until = excluded.until`,
        args: [targetId, fingerprint, until.toISOString()],
      },
      {
        sql: `UPDATE incidents
              SET notified_at = COALESCE(notified_at, ?), pending_since = NULL, ${CLEAR_CLAIM},
                  version = version + 1
              WHERE target = ? AND fingerprint = ?`,
        args: [now.toISOString(), targetId, fingerprint],
      },
    ],
    "write",
  );
}

export async function getIncident(db: Client, id: number): Promise<Incident | null> {
  const { rows } = await db.execute({ sql: "SELECT * FROM incidents WHERE id = ?", args: [id] });
  return rows[0] ? toIncident(rows[0]) : null;
}

/** 보낼 incident를 등급 높은 순으로 돌려준다. 다른 실행이 보내는 중인 행은 뺀다. */
export async function listPending(db: Client, targetId: string, now: Date): Promise<Incident[]> {
  const { rows } = await db.execute({
    sql: `SELECT * FROM incidents
          WHERE target = ? AND status = 'open' AND notified_at IS NULL
            AND (notify_claimed_at IS NULL OR notify_claimed_at <= ?)
          ORDER BY severity, pending_since, id`,
    args: [targetId, isoBefore(now, CLAIM_TTL_MS)],
  });
  return rows.map(toIncident);
}

/** Sentry에서 해결됐는지 따로 확인할 열린 incident. 오래 조용했던 것부터 돌려준다. */
export async function listOpenSentryIncidents(
  db: Client,
  targetId: string,
  limit: number,
): Promise<Incident[]> {
  const { rows } = await db.execute({
    sql: `SELECT * FROM incidents
          WHERE target = ? AND status = 'open' AND fingerprint LIKE 'sentry:%'
          ORDER BY last_seen LIMIT ?`,
    args: [targetId, limit],
  });
  return rows.map(toIncident);
}

/**
 * 전송을 시작한다. 성공하면 이 전송의 표를 돌려준다. webhook과 cron이 겹쳐도 한쪽만 받는다.
 * 표는 완료·취소할 때 내야 한다. 그사이 등급이 오르거나 재개방되면 표는 무효가 된다.
 */
export async function claimNotification(
  db: Client,
  id: number,
  now: Date,
): Promise<string | null> {
  const claim = crypto.randomUUID();
  const { rowsAffected } = await db.execute({
    sql: `UPDATE incidents SET notify_claimed_at = ?, notify_claim = ?
          WHERE id = ? AND status = 'open' AND notified_at IS NULL
            AND (notify_claimed_at IS NULL OR notify_claimed_at <= ?)`,
    args: [now.toISOString(), claim, id, isoBefore(now, CLAIM_TTL_MS)],
  });
  return rowsAffected === 1 ? claim : null;
}

/** 전달 완료로 기록한다. 표가 무효가 됐으면 false이고, 새 알림은 그대로 대기한다. */
export async function completeNotification(
  db: Client,
  id: number,
  claim: string,
  slackTs: string | null,
  now: Date,
): Promise<boolean> {
  const { rowsAffected } = await db.execute({
    sql: `UPDATE incidents
          SET notified_at = ?, slack_ts = COALESCE(?, slack_ts), ${CLEAR_CLAIM}, pending_since = NULL
          WHERE id = ? AND notify_claim = ?`,
    args: [now.toISOString(), slackTs, id, claim],
  });
  return rowsAffected === 1;
}

/** 전송에 실패하면 표를 돌려줘 다음 실행이 다시 보내게 한다. */
export async function releaseNotification(db: Client, id: number, claim: string): Promise<void> {
  await db.execute({
    sql: `UPDATE incidents SET ${CLEAR_CLAIM} WHERE id = ? AND notify_claim = ?`,
    args: [id, claim],
  });
}

/** 보내지 못한 incident가 15분 넘게 쌓였으면 true. 이때는 heartbeat를 보내지 않는다. */
export async function isDeliveryOverdue(db: Client, now: Date): Promise<boolean> {
  const { rows } = await db.execute({
    sql: `SELECT 1 FROM incidents
          WHERE status = 'open' AND notified_at IS NULL AND pending_since <= ?
          LIMIT 1`,
    args: [isoBefore(now, DELIVERY_OVERDUE_MS)],
  });
  return rows.length > 0;
}

/** 같은 시각 다른 사이트에도 에러가 있었는지. incident는 합치지 않고 메시지에만 표시한다. */
export async function findCorrelatedTargets(
  db: Client,
  incident: Pick<Incident, "target" | "lastSeen">,
): Promise<string[]> {
  const at = Date.parse(incident.lastSeen);
  const { rows } = await db.execute({
    sql: `SELECT DISTINCT target FROM incidents
          WHERE target != ? AND fingerprint LIKE 'sentry:%' AND last_seen BETWEEN ? AND ?
          ORDER BY target`,
    args: [
      incident.target,
      new Date(at - CORRELATION_WINDOW_MS).toISOString(),
      new Date(at + CORRELATION_WINDOW_MS).toISOString(),
    ],
  });
  return rows.map((row) => String(row.target));
}

/** 배포 id마다 최종 상태를 유지한다. 늦게 도착한 과거 상태는 무시한다. */
export async function recordDeploys(
  db: Client,
  deploys: readonly Deploy[],
  now: Date,
): Promise<void> {
  if (deploys.length === 0) return;
  await db.batch(
    deploys.map((deploy) => ({
      sql: `INSERT INTO deploys (deployment_id, target, sha, state, created_at, ready_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (deployment_id) DO UPDATE
            SET state = excluded.state, sha = COALESCE(excluded.sha, deploys.sha),
                ready_at = COALESCE(excluded.ready_at, deploys.ready_at),
                updated_at = excluded.updated_at
            WHERE deploys.state NOT IN (${FINAL_DEPLOY_STATES})
               OR excluded.state IN (${FINAL_DEPLOY_STATES})`,
      args: [
        deploy.deploymentId,
        deploy.target,
        deploy.sha,
        deploy.state,
        deploy.createdAt,
        deploy.readyAt,
        now.toISOString(),
      ],
    })),
    "write",
  );
}

export async function getCursor(
  db: Client,
  targetId: string,
  source: SignalSource,
): Promise<string | null> {
  const { rows } = await db.execute({
    sql: "SELECT cursor FROM cursors WHERE target = ? AND source = ?",
    args: [targetId, source],
  });
  return rows[0] ? String(rows[0].cursor) : null;
}

export async function saveCursor(
  db: Client,
  targetId: string,
  source: SignalSource,
  cursor: string,
  now: Date,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO cursors (target, source, cursor, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT (target, source) DO UPDATE
          SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
    args: [targetId, source, cursor, now.toISOString()],
  });
}

/** 잠금을 잡으면 true. 다른 실행이 잡고 있고 만료 전이면 false. */
export async function acquireLock(
  db: Client,
  name: string,
  holder: string,
  now: Date,
): Promise<boolean> {
  const { rowsAffected } = await db.execute({
    sql: `INSERT INTO locks (name, holder, expires_at) VALUES (?, ?, ?)
          ON CONFLICT (name) DO UPDATE
          SET holder = excluded.holder, expires_at = excluded.expires_at
          WHERE locks.expires_at <= ?`,
    args: [name, holder, new Date(now.getTime() + LOCK_TTL_MS).toISOString(), now.toISOString()],
  });
  return rowsAffected === 1;
}

/** 자기가 잡은 잠금만 푼다. 만료 뒤 다른 실행이 잡은 잠금은 건드리지 않는다. */
export async function releaseLock(db: Client, name: string, holder: string): Promise<void> {
  await db.execute({
    sql: "DELETE FROM locks WHERE name = ? AND holder = ?",
    args: [name, holder],
  });
}

/**
 * 보관 기간이 지난 행을 지운다. 열린 incident는 남긴다.
 * 끝난 음소거도 180일 동안 남긴다. '음소거가 끝난 뒤 첫 발생'을 판단하는 근거이기 때문이다.
 */
export async function purgeExpired(db: Client, now: Date): Promise<void> {
  const cutoff = isoBefore(now, RETENTION_MS);
  await db.batch(
    [
      {
        sql: "DELETE FROM incidents WHERE status = 'resolved' AND resolved_at < ?",
        args: [cutoff],
      },
      { sql: "DELETE FROM deploys WHERE created_at < ?", args: [cutoff] },
      { sql: "DELETE FROM mutes WHERE until < ?", args: [cutoff] },
      { sql: "DELETE FROM locks WHERE expires_at < ?", args: [now.toISOString()] },
    ],
    "write",
  );
}
