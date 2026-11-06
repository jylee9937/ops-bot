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
- [ ] 수집기와 마스킹
- [ ] incident 규칙
- [ ] Slack 알림과 버튼
- [ ] collect와 heartbeat
- [ ] 배포 실패 webhook
- [ ] Claude 요약과 평가
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

감시 대상은 코드가 아니라 `OPS_TARGETS` 환경변수로 받습니다. 형식은 `.env.example`과 `lib/targets.ts`를 보세요.
