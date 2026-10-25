import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { type GameEvent, seatLabel } from "../engine/types.ts";
import { formatEvent } from "../judge/format.ts";
import { boolArg, parseArgs, stringArg } from "./args.ts";
import { exitAfterFlush } from "./exit.ts";

const HELP = `用法：node src/cli/replay.ts <run目录或events.ndjson> [选项]

  --show-private   显示私密事件（查验结果、女巫用药、狼队频道）
  --show-roles     显示开局身份分配
  --verbose        显示法官内部事件（turn_start / 错误 / 保底动作）
  --help           显示帮助`;

function readEvents(path: string): GameEvent[] {
	const eventsPath = statSync(path).isDirectory() ? join(path, "events.ndjson") : path;
	if (!existsSync(eventsPath)) throw new Error(`找不到事件文件：${eventsPath}`);
	return readFileSync(eventsPath, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as GameEvent);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (boolArg(args, "help")) {
		console.log(HELP);
		return;
	}
	const target = args.positionals[0] ?? stringArg(args, "run");
	if (!target) {
		console.error(HELP);
		process.exitCode = 1;
		return;
	}
	const showPrivate = boolArg(args, "show-private");
	const showRoles = boolArg(args, "show-roles");
	const verbose = boolArg(args, "verbose");
	const events = readEvents(target);
	const first = events[0];
	if (!first) throw new Error("事件日志为空");
	console.log(`对局：${first.gameId}`);
	console.log(`事件：${events.length} 条`);
	console.log("");

	for (const event of events) {
		if (event.visibility.kind === "public") {
			console.log(formatEvent(event));
			continue;
		}
		if (event.visibility.kind === "seat") {
			if (showPrivate) {
				console.log(`[私密→${seatLabel(event.visibility.seat)}] ${formatEvent(event)}`);
			}
			continue;
		}
		if (event.visibility.kind === "wolves") {
			if (showPrivate) console.log(`[狼队] ${formatEvent(event)}`);
			continue;
		}
		if (event.visibility.kind === "judge") {
			if (event.type === "role_assigned" && showRoles) {
				console.log(`[身份] ${event.text}`);
			} else if (verbose) {
				console.log(`[法官] ${formatEvent(event)}`);
			}
		}
	}

	const summaryPath = statSync(target).isDirectory()
		? join(target, "summary.json")
		: join(dirname(target), "summary.json");
	if (existsSync(summaryPath)) {
		const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as Record<string, unknown>;
		console.log("");
		console.log("—— 摘要 ——");
		console.log(
			`胜者：${summary.winner ?? "中止"}；天数：${summary.days ?? "?"}；结束原因：${summary.endReason ?? "?"}`,
		);
		console.log(`异常：${JSON.stringify(summary.violations ?? {})}`);
		if (summary.error) console.log(`错误：${String(summary.error)}`);
	}
}

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
exitAfterFlush();
