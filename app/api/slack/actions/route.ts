import { after } from "next/server";
import { openDb } from "@/lib/incidents";
import { handleAction } from "@/lib/report";
import { ephemeral, parseInteraction, readSlackRequest, respond } from "@/lib/slack";
import { parseTargets } from "@/lib/targets";

/**
 * Slack 버튼. 서명과 누른 사람을 확인한 뒤 바로 200을 돌려준다(3초 제한).
 * 상태 변경과 메시지 갱신은 응답 뒤에 하고, 실패하면 누른 사람에게만 알린다.
 */
export async function POST(request: Request): Promise<Response> {
  const checked = await readSlackRequest(request, {
    secret: process.env.SLACK_SIGNING_SECRET,
    ownerUserId: process.env.SLACK_OWNER_USER_ID,
    now: new Date(),
  });
  if (!checked.ok) return new Response(null, { status: checked.status });

  const interaction = parseInteraction(checked.body);
  if (interaction.kind === "invalid") return new Response(null, { status: 400 });
  if (interaction.kind === "ignore") return new Response(null, { status: 200 });

  if (interaction.userId !== checked.ownerUserId) {
    after(() =>
      respond(interaction.responseUrl, ephemeral("이 버튼은 담당자만 누를 수 있습니다.")).catch(
        () => undefined,
      ),
    );
    return new Response(null, { status: 200 });
  }

  after(async () => {
    let db: ReturnType<typeof openDb> | undefined;
    try {
      db = openDb();
      const targets = parseTargets(process.env.OPS_TARGETS);
      await respond(interaction.responseUrl, await handleAction(db, targets, interaction, new Date()));
    } catch (error) {
      console.error("[slack/actions] 버튼 처리 실패", error instanceof Error ? error.name : "unknown");
      await respond(
        interaction.responseUrl,
        ephemeral("처리하지 못했습니다. 잠시 뒤 다시 눌러 주세요."),
      ).catch(() => undefined);
    } finally {
      db?.close();
    }
  });
  return new Response(null, { status: 200 });
}
