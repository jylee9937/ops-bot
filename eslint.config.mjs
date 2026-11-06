import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // 표의 주인은 lib/incidents.ts 하나다. route나 다른 모듈이 직접 쿼리하지 않는다.
  {
    files: ["**/*.{ts,tsx}"],
    ignores: ["lib/db.ts", "lib/db.test.ts", "lib/incidents.ts", "lib/incidents.test.ts", "scripts/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/db", "**/lib/db", "./db", "../db"],
              message: "lib/db는 lib/incidents.ts만 import합니다.",
            },
          ],
        },
      ],
    },
  },
  // 핵심 로직은 Next.js 없이 동작해야 다른 런타임으로 옮길 수 있다.
  {
    files: ["lib/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["next", "next/*"], message: "lib/는 Next.js를 import하지 않습니다." },
            {
              group: ["@/lib/db", "**/lib/db", "./db", "../db"],
              message: "lib/db는 lib/incidents.ts만 import합니다.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["lib/db.ts", "lib/db.test.ts", "lib/incidents.ts", "lib/incidents.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["next", "next/*"], message: "lib/는 Next.js를 import하지 않습니다." }] },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
