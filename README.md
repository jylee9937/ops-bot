# ops-bot

여러 웹 서비스의 에러와 배포 신호를 한곳에 모아, 규칙으로 판단해 Slack으로 알리는 운영 모니터링 봇입니다.

Sentry, Vercel, Supabase를 각각 열어 비교하지 않아도 "배포 직후인가, DB 쪽인가, 여러 사이트가 함께인가"를 바로 알 수 있게 하는 것이 목표입니다.

## 동작 방식

```
Vercel Cron (5분) ─▶ collect ─▶ 잠금 획득 실패면 종료
                       │
         사이트 × 출처마다 (실패는 서로 격리)
         수집기: 응답을 받는 즉시 마스킹 ─▶ Signal
                       │                 ▲
Vercel webhook ─서명 검증─▶ ingest ◀─────┘
                       │
         incidents: 규칙 판단 · 지문 · 등급 · 재발 처리
                       │
         report: Claude 요약(상한 안) 또는 템플릿 ─▶ Slack
                       │
         전부 성공 ─▶ 외부 heartbeat
```

## 설계에서 지키는 것

- **알릴지는 규칙이 정하고, Claude는 설명만 합니다.** 같은 입력이면 같은 알림이 나가고, Claude가 멈춰도 알림은 나갑니다.
- **개인정보는 입구에서 막습니다.** 코드에 적힌 고정 문구까지만 가져오고, 마스킹하지 않은 문자열은 타입 검사에서 저장·전송을 거부합니다.
- **외부에서 온 글자를 믿지 않습니다.** Sentry DSN은 공개 값이라 메시지가 위조될 수 있습니다. Claude에게는 도구를 주지 않고, Slack 텍스트는 이스케이프합니다.
- **Cron은 중복·누락된다고 가정합니다.** 잠금과 '마지막 성공 이후 다시 읽기'로 처리합니다.
- **조용히 틀리지 않습니다.** 수집이 실패하거나 알림이 나가지 못하면 외부 heartbeat가 끊겨 이메일이 옵니다.

## 진행 상태

- [x] 프로젝트 기반: Next.js, Vitest, CI, DB 스키마, 감시 대상 설정
- [x] 수집기와 마스킹
- [x] incident 규칙
- [x] Slack 알림과 버튼
- [x] collect와 heartbeat
- [x] 배포 실패 webhook
- [x] Claude 요약과 평가
- [ ] 통합 대시보드

## 개발

```bash
pnpm install
cp .env.example .env.local
pnpm db:migrate
pnpm dev
```

| 명령 | 내용 |
|---|---|
| `pnpm lint` | ESLint. `lib/db`를 `lib/incidents` 밖에서 import하면 실패합니다 |
| `pnpm typecheck` | 라우트 타입 생성 후 `tsc` |
| `pnpm test` | Vitest |
| `pnpm build` | 프로덕션 빌드 |
| `pnpm eval` | Claude 요약 고정 시나리오 8건을 실제 API로 실행(비용 발생, CI 제외). `ANTHROPIC_API_KEY` 필요 |

감시 대상은 코드가 아니라 `OPS_TARGETS` 환경변수로 받습니다. 형식은 `.env.example`과 `lib/targets.ts`를 보세요.

### 운영 실행

- `vercel.json`의 Cron이 5분마다 `GET /api/cron/collect`를 부릅니다(`Authorization: Bearer CRON_SECRET`).
- 한 번의 실행: 잠금 → 스키마 확인 → 사이트마다 Vercel 배포 → Sentry issue → Sentry 해결 확인 → Slack 전송 → 정리 → heartbeat.
- 출처 하나가 실패해도 나머지는 계속합니다. 실패한 출처는 커서를 옮기지 않아 다음 실행이 다시 읽습니다.
- heartbeat는 모든 수집 단계가 성공하고 15분 넘게 못 보낸 알림이 없을 때만 보냅니다.
- 응답에는 단계별 성공 여부와 건수만 담습니다. 설정이 틀리면 문제가 있는 변수 이름만 돌려줍니다.

### 배포 실패 webhook

- Vercel 팀 Settings → Webhooks에서 **Deployment Error** 이벤트로 `https://<배포 주소>/api/webhooks/vercel`을 등록하고, 표시되는 비밀을 `VERCEL_WEBHOOK_SECRET`에 넣습니다.
- `x-vercel-signature`(본문의 HMAC-SHA1)를 먼저 확인합니다. 운영(`target=production`)이면서 설정에 있는 프로젝트의 실패만 처리하고, 나머지는 200으로 무시합니다.
- 폴링과 같은 지문이라 둘 다 받아도 알림은 한 번입니다. 25시간보다 오래된 이벤트는 재전송으로 보고 무시합니다.

### Claude 요약

- 상세 알림(사이트마다 실행당 5건)을 보내기 전에 Claude가 근거를 읽고 요약·의심 계층·사용자 영향·먼저 볼 것을 씁니다. 등급과 알릴지는 규칙이 정하고, 요약은 참고용입니다.
- 근거는 마스킹을 통과한 값만 넘깁니다: 제목·경로·스택(파일·함수·줄)·숫자·배포 시각·같은 시각 에러가 난 다른 사이트. 데이터 블록으로 넘기고 그 안의 문장은 지시로 따르지 않게 합니다. 도구는 주지 않고 답 형식은 JSON Schema로 강제합니다.
- 상한: 실행당 5회, 하루(KST) 50회. 넘거나 호출이 실패·거절·시간 초과면 요약 없이 템플릿으로 보내고, 알림 아래에 이유를 적습니다. 배포 실패 webhook은 30초 안에 응답해야 해서 부르지 않습니다.
- 같은 회차·등급의 요약은 저장해 두고 다시 보낼 때 재사용합니다. 등급이 오르거나 다시 열리면 새로 만듭니다.
- 같은 시각(앞뒤 5분) 다른 사이트에도 에러가 있으면 incident는 따로 두고 메시지에 그 사이트와 Vercel·Supabase 상태 페이지 링크를 붙입니다.
- `ANTHROPIC_API_KEY`가 없으면 요약 없이 동작합니다. 프롬프트나 모델을 바꿀 때는 `pnpm eval`로 판정(의심 계층·배포 연관·교차 사이트)과 주입 내성을 확인합니다. 시나리오는 `evals/scenarios.ts`.

### Slack 앱

- 봇 토큰 권한: `chat:write`. 알림 채널마다 봇을 초대해야 보낼 수 있습니다.
- Interactivity Request URL: `https://<배포 주소>/api/slack/actions`
- 환경변수: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_OWNER_USER_ID`(버튼을 누를 수 있고 P1에 멘션할 사람)
- 버튼은 ops-bot 상태만 바꿉니다. Sentry에는 쓰지 않습니다.
