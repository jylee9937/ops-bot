import { z } from "zod";
import { isSlackUserId } from "./slack";
import type { SentryConfig } from "./sources/sentry";
import type { UptimeRobotConfig } from "./sources/uptimerobot";
import type { VercelConfig } from "./sources/vercel";
import { parseTargets, TargetsConfigError, type Target } from "./targets";

/** collect에 필요한 설정. 값은 로그·응답에 내보내지 않는다. */
export type CollectEnv = {
  targets: Target[];
  sentry: SentryConfig | null;
  vercel: VercelConfig;
  slack: { token: string; ownerUserId: string };
  heartbeatUrl: string | null;
  // 없으면 Claude 요약 없이 템플릿으로만 알린다.
  anthropicApiKey: string | null;
  // 없으면 외부 감시 단계를 건너뛴다. 이전 설정으로 만든 deps에는 칸이 없을 수 있다.
  uptimeRobot?: UptimeRobotConfig | null;
};

/** 설정 오류. 문제가 있는 변수 이름만 담는다. 값은 담지 않는다. */
export class EnvError extends Error {
  override name = "EnvError";

  constructor(readonly keys: string[]) {
    super(`환경변수를 확인하세요: ${keys.join(", ")}`);
  }
}

const optional = (value: string | undefined) => (value === undefined || value === "" ? undefined : value);

const schema = z.object({
  TURSO_DATABASE_URL: z.string().min(1),
  OPS_TARGETS: z.string().min(1),
  SENTRY_ORG: z.preprocess(optional, z.string().regex(/^[a-z0-9][a-z0-9_-]{0,49}$/).optional()),
  SENTRY_TOKEN: z.preprocess(optional, z.string().min(1).optional()),
  VERCEL_TEAM_ID: z.string().regex(/^team_[A-Za-z0-9]{1,60}$/),
  VERCEL_TOKEN: z.string().min(1),
  SLACK_BOT_TOKEN: z.string().startsWith("xoxb-"),
  SLACK_OWNER_USER_ID: z.string().refine((value) => isSlackUserId(value)),
  HEARTBEAT_URL: z.preprocess(optional, z.url({ protocol: /^https$/ }).optional()),
  // 형식은 검사하지 않는다. 잘못된 키는 수집을 막지 않고, 알림에 'API 키 확인 필요'로 드러난다.
  ANTHROPIC_API_KEY: z.preprocess(optional, z.string().min(1).optional()),
  // UptimeRobot Read-only 키. 읽기만 하므로 감시를 바꾸거나 지울 수 없다.
  UPTIMEROBOT_API_KEY: z.preprocess(optional, z.string().regex(/^[A-Za-z0-9_-]{8,200}$/).optional()),
});

/**
 * collect가 쓰는 환경변수를 한 번에 검사한다. 하나라도 틀리면 그 이름들을 담아 던진다.
 * Sentry는 Sentry를 쓰는 target이 있을 때만 필요하다. heartbeat는 운영에만 둔다. Claude 키는 선택이다.
 */
export function loadCollectEnv(env: Record<string, string | undefined>): CollectEnv {
  const parsed = schema.safeParse(env);
  const bad = new Set<string>(
    parsed.success ? [] : parsed.error.issues.map((issue) => String(issue.path[0])),
  );

  let targets: Target[] = [];
  try {
    targets = parseTargets(env.OPS_TARGETS);
  } catch (error) {
    if (!(error instanceof TargetsConfigError)) throw error;
    bad.add("OPS_TARGETS");
  }

  // 로컬 파일(file:)이 아닌 원격 DB는 토큰이 있어야 연결된다.
  const dbUrl = optional(env.TURSO_DATABASE_URL);
  if (dbUrl && !dbUrl.startsWith("file:") && !optional(env.TURSO_AUTH_TOKEN)) bad.add("TURSO_AUTH_TOKEN");

  // 다른 변수가 틀려도 Sentry 설정이 있는지는 원래 값으로 본다. 형식은 위 스키마가 검사했다.
  if (targets.some((target) => target.sentry)) {
    if (!optional(env.SENTRY_ORG)) bad.add("SENTRY_ORG");
    if (!optional(env.SENTRY_TOKEN)) bad.add("SENTRY_TOKEN");
  }
  const data = parsed.success ? parsed.data : null;
  if (bad.size > 0 || !data) throw new EnvError([...bad].sort());

  return {
    targets,
    sentry: data.SENTRY_ORG && data.SENTRY_TOKEN ? { org: data.SENTRY_ORG, token: data.SENTRY_TOKEN } : null,
    vercel: { teamId: data.VERCEL_TEAM_ID, token: data.VERCEL_TOKEN },
    slack: { token: data.SLACK_BOT_TOKEN, ownerUserId: data.SLACK_OWNER_USER_ID },
    heartbeatUrl: data.HEARTBEAT_URL ?? null,
    anthropicApiKey: data.ANTHROPIC_API_KEY ?? null,
    uptimeRobot: data.UPTIMEROBOT_API_KEY ? { apiKey: data.UPTIMEROBOT_API_KEY } : null,
  };
}
