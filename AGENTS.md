<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# ops-bot 작업 규칙

- **공개 repo입니다.** 실제 사이트 이름·도메인·프로젝트 ID·DSN·토큰을 코드, 테스트, 문서, 커밋 메시지에 넣지 않습니다. 감시 대상은 `OPS_TARGETS` 환경변수로 받고, 테스트에는 `site-a` 같은 예시 값만 씁니다.
- **모듈 경계**: 표는 `lib/incidents.ts`만 다룹니다(`lib/db`는 lint로 강제). `lib/`는 Next.js를 import하지 않고, route는 인증 후 `lib/` 함수를 호출만 합니다.
- **마스킹은 입구에서**: `lib/sources/*`가 외부 응답을 받을 때 지웁니다. 저장·Claude·Slack은 마스킹된 타입만 받습니다.
- **판단은 규칙이**: 알릴지와 등급은 규칙이 정합니다. Claude는 설명만 하고 도구를 갖지 않습니다.
- **완료 기준**: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
