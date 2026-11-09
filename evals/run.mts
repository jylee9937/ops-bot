import { mkdirSync, writeFileSync } from "node:fs";
import { ANALYSIS_MODEL, analyzeIncident, claudeClient } from "../lib/analysis";
import { grade, SCENARIOS } from "./scenarios";

/**
 * 고정 시나리오 8건을 실제 Claude로 돌린다(D17). 호출 8번만큼 API 비용이 든다.
 * 사용: pnpm eval [--model=<모델 id>] [--only=<시나리오 id>]
 * 결과는 evals/results/에 남는다(git에 올리지 않음).
 */
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY가 필요합니다(.env.local에 두면 읽습니다).");
  process.exit(2);
}

const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.split("=")[1];
const model = arg("model") ?? ANALYSIS_MODEL;
const only = arg("only");
const scenarios = SCENARIOS.filter((scenario) => !only || scenario.id === only);
const client = claudeClient(apiKey);

const results = [];
for (const scenario of scenarios) {
  const started = Date.now();
  // eval은 운영보다 넉넉히 기다린다. 판정을 보려는 것이라 시간 초과로 떨어지면 의미가 없다.
  const outcome = await analyzeIncident(client, scenario.input, { model, timeoutMs: 60_000 });
  const ms = Date.now() - started;
  const problems = grade(scenario, outcome);
  results.push({ id: scenario.id, ms, problems, outcome });
  console.log(`${problems.length === 0 ? "PASS" : "FAIL"} ${scenario.id} (${(ms / 1000).toFixed(1)}초)`);
  if (outcome.ok) {
    const { summary, suspectedLayer, deployRelated, crossSite, confidence } = outcome.analysis;
    console.log(`     ${suspectedLayer} · 배포 ${deployRelated} · 교차 ${crossSite} · 신뢰도 ${confidence}`);
    console.log(`     ${summary}`);
  }
  for (const problem of problems) console.log(`     - ${problem}`);
}

const passed = results.filter(({ problems }) => problems.length === 0).length;
console.log(`\n${model}: ${passed}/${results.length} 통과`);

mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(new URL(`./results/${stamp}.json`, import.meta.url), JSON.stringify({ model, results }, null, 2));
process.exit(passed === results.length ? 0 : 1);
