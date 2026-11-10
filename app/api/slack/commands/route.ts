import { after } from "next/server";
import { ackText, parseOpsCommand, runOpsCommand } from "@/lib/commands";
import { ephemeral, parseSlashCommand, readSlackRequest, respond } from "@/lib/slack";

// collect의 실행 예산(90초)과 eval 호출 제한(60초)보다 길게 둔다. after()도 이 시간 안에서 돈다.
export const maxDuration = 120;

const reply = (text: string) => Response.json(ephemeral(text));

/**
 * Slack 슬래시 명령 `/ops`. 서명과 부른 사람을 확인하고 3초 안에 첫 답을 돌려준다.
 * 실제 일(status·collect·eval)은 응답 뒤에 하고 결과를 `response_url`로 부른 사람에게만 보낸다.
 */
export async function POST(request: Request): Promise<Response> {
  const checked = await readSlackRequest(request, {
    secret: process.env.SLACK_SIGNING_SECRET,
    ownerUserId: process.env.SLACK_OWNER_USER_ID,
    now: new Date(),
  });
  if (!checked.ok) return new Response(null, { status: checked.status });

  const slash = parseSlashCommand(checked.body);
  if (slash.kind === "invalid") return new Response(null, { status: 400 });
  if (slash.kind === "ignore") return new Response(null, { status: 200 });

  // 담당자가 아니면 아무 일도 하지 않는다. 어떤 명령이 있는지도 알려 주지 않는다.
  if (slash.userId !== checked.ownerUserId) return reply("이 명령은 담당자만 쓸 수 있습니다.");

  const command = parseOpsCommand(slash.text);
  if (command.kind === "reply") return reply(command.text);

  after(async () => {
    let text: string | null;
    try {
      // 서명은 요청마다 다르다. 같은 서명이 다시 오면(재전송·재생) 실행하지 않는다.
      text = await runOpsCommand(command, process.env, checked.signature);
    } catch (error) {
      console.error(`[slack/commands] ${command.kind} 실패`, error instanceof Error ? error.name : "unknown");
      text = "처리하지 못했습니다. 잠시 뒤 다시 해 보세요.";
    }
    if (text === null) {
      console.info(`[slack/commands] ${command.kind}: 이미 받은 요청이라 건너뜀`);
      return;
    }
    await respond(slash.responseUrl, ephemeral(text)).catch((error: unknown) => {
      console.error("[slack/commands] 결과 전송 실패", error instanceof Error ? error.name : "unknown");
    });
  });
  return reply(ackText(command));
}
