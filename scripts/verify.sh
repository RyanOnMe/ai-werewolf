#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== typecheck =="
npm run typecheck

echo "== tests =="
node --test --test-concurrency=1 test/*.test.ts

echo "== scripted CLI game =="
RUN_DIR="runs/verify-$(date +%s)"
node src/cli/play.ts --scripted --seed verify-seed --out "$RUN_DIR" --quiet

echo "== check summary =="
node - "$RUN_DIR" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const dir = process.argv[2];
const summary = JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf8"));
const lines = fs
  .readFileSync(path.join(dir, "events.ndjson"), "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0);
const last = JSON.parse(lines[lines.length - 1]);
const problems = [];
if (!summary.winner) problems.push(`winner is ${summary.winner}`);
if (summary.phase !== "ended") problems.push(`phase is ${summary.phase}`);
if (summary.violations.ruleRejections !== 0) {
  problems.push(`ruleRejections=${summary.violations.ruleRejections}`);
}
if (lines.length < 40) problems.push(`too few events: ${lines.length}`);
if (last.type !== "game_end") problems.push(`last event is ${last.type}`);
if (summary.eventCount !== lines.length) {
  problems.push(`eventCount=${summary.eventCount} but log has ${lines.length}`);
}
if (problems.length > 0) {
  console.error(`verify failed: ${problems.join("; ")}`);
  process.exit(1);
}
console.log(
  `verify game ok: winner=${summary.winner} days=${summary.days} events=${lines.length} (${dir})`,
);
NODE
