#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== typecheck =="
npm run typecheck

echo "== tests =="
node --test --test-concurrency=1 test/*.test.ts

check_game() {
	local run_dir="$1"
	local expected_count="$2"
	local expected_sheriff="$3"
	echo "== check summary: $run_dir =="
	node - "$run_dir" "$expected_count" "$expected_sheriff" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [dir, expectedCountText, expectedSheriffText] = process.argv.slice(2);
const expectedCount = Number(expectedCountText);
const expectedSheriff = expectedSheriffText === "yes";
const summary = JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf8"));
const events = fs
  .readFileSync(path.join(dir, "events.ndjson"), "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));
const last = events[events.length - 1];
const problems = [];
if (!summary.winner) problems.push(`winner is ${summary.winner}`);
if (summary.phase !== "ended") problems.push(`phase is ${summary.phase}`);
if (summary.playerCount !== expectedCount) {
  problems.push(`playerCount=${summary.playerCount}, expected ${expectedCount}`);
}
if (summary.violations.ruleRejections !== 0) {
  problems.push(`ruleRejections=${summary.violations.ruleRejections}`);
}
if (events.length < (expectedCount === 12 ? 60 : 40)) {
  problems.push(`too few events: ${events.length}`);
}
if (last.type !== "game_end") problems.push(`last event is ${last.type}`);
if (summary.eventCount !== events.length) {
  problems.push(`eventCount=${summary.eventCount} but log has ${events.length}`);
}
const sheriffEvents = events.filter((event) => event.type === "sheriff_elected");
if (expectedSheriff && sheriffEvents.length !== 1) {
  problems.push(`expected one sheriff_elected, got ${sheriffEvents.length}`);
}
if (!expectedSheriff && sheriffEvents.length !== 0) {
  problems.push(`9p game unexpectedly has sheriff_elected`);
}
for (const lastWords of events.filter((event) => event.type === "last_words")) {
  const death = summary.deaths[String(lastWords.actor)];
  if (death && death.phase === "dawn") {
    problems.push(`night death ${lastWords.actor} has last words`);
  }
}
if (problems.length > 0) {
  console.error(`verify failed: ${problems.join("; ")}`);
  process.exit(1);
}
console.log(
  `verify game ok: winner=${summary.winner} days=${summary.days} events=${events.length} playerCount=${expectedCount} (${dir})`,
);
NODE
}

STAMP="$(date +%s)"
RUN_9P="runs/verify-9p-${STAMP}"
RUN_12P="runs/verify-12p-${STAMP}"

echo "== scripted CLI game: 9p =="
node src/cli/play.ts --mode 9p --scripted --seed verify-9p-seed --out "$RUN_9P" --quiet
check_game "$RUN_9P" 9 no

echo "== scripted CLI game: 12p =="
node src/cli/play.ts --mode 12p --scripted --seed verify-12p-seed --out "$RUN_12P" --quiet
check_game "$RUN_12P" 12 yes
