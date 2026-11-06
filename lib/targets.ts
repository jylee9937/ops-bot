import { z } from "zod";

const areaSchema = z.object({
  name: z.string().min(1),
  severity: z.enum(["P1", "P2", "P3"]),
  // 로그 태그 또는 route. 예: "articles", "admin/lectures", "/api/playback"
  match: z.array(z.string().min(1)).min(1),
});

const targetSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  vercel: z.object({
    projectId: z.string().min(1),
    productionBranch: z.string().min(1),
  }),
  // Sentry를 아직 설치하지 않은 사이트는 생략한다. 수집과 heartbeat 판단에서 빠진다.
  sentry: z
    .object({
      project: z.string().min(1),
      environment: z.string().min(1).default("production"),
    })
    .optional(),
  slackChannel: z.string().regex(/^#[^\s]+$/),
  areas: z.array(areaSchema).default([]),
});

const targetsSchema = z
  .array(targetSchema)
  .min(1)
  .superRefine((targets, ctx) => {
    const seen = new Set<string>();
    for (const [index, target] of targets.entries()) {
      if (seen.has(target.id)) {
        ctx.addIssue({
          code: "custom",
          message: `중복된 target id: ${target.id}`,
          path: [index, "id"],
        });
      }
      seen.add(target.id);
    }
  });

export type Target = z.infer<typeof targetSchema>;
export type Area = z.infer<typeof areaSchema>;
export type Severity = Area["severity"];

export class TargetsConfigError extends Error {
  override name = "TargetsConfigError";
}

/** `OPS_TARGETS` 환경변수를 읽는다. 사이트 정보는 공개 repo에 두지 않는다. */
export function parseTargets(raw: string | undefined): Target[] {
  if (!raw) throw new TargetsConfigError("OPS_TARGETS가 비어 있습니다");

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new TargetsConfigError("OPS_TARGETS가 올바른 JSON이 아닙니다");
  }

  const result = targetsSchema.safeParse(json);
  if (!result.success) {
    throw new TargetsConfigError(z.prettifyError(result.error));
  }
  return result.data;
}
