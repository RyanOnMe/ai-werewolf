import { join } from "node:path";
import { type AgentEvent } from "@earendil-works/pi-agent-core";
import {
	type GameEvent,
	type PlayerPolicy,
	type PlayerView,
	type Role,
	type TurnRequest,
	ROLE_LABEL,
	seatLabel,
} from "../engine/types.ts";
import type { GameEngine } from "../engine/engine.ts";
import type { LoadedModel } from "../agents/model.ts";
import { formatEvent } from "../judge/format.ts";
import { runGame, type GameRunResult } from "../judge/runner.ts";
import { RandomPolicy } from "../agents/scripted.ts";
import { PiPlayer } from "../agents/pi-player.ts";
import { boolArg, numberArg, parseArgs, stringArg } from "./args.ts";
import { exitAfterFlush } from "./exit.ts";

const HELP = `用法：node src/cli/play.ts [选项]

  --seed <string>       随机种子（默认当前时间）
  --game-id <string>    对局 ID（默认 seed + 时间戳）
  --out <dir>           输出目录（默认 runs/<gameId>）
  --scripted            使用无 LLM 的随机策略（不需要模型鉴权）
  --model <provider/id> 玩家模型，例如 openai-codex/gpt-5.6-luna
  --thinking <level>    minimal|low|medium|high|xhigh|max（默认 low）
  --max-tokens <n>      每次模型输出上限（默认 2000）
  --max-days <n>        最大天数（默认 30）
  --timeout <seconds>   单回合超时（默认 240）
  --show-private        同时打印私密/狼队事件（旁观/调试）
  --verbose             打印工具调用、法官事件和等待状态
  --quiet               只打印最终摘要
  --help                显示帮助`;

function sanitizeId(value: string): string {
	const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return (cleaned || "game").slice(0, 60);
}

function extractToolText(result: unknown): string {
	const content = (result as { content?: { type?: string; text?: string }[] })?.content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (part.type === "text" ? (part.text ?? "") : ""))
		.join(" ")
		.trim();
}

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function printSummary(result: GameRunResult): void {
	const end = result.events.find((event) => event.type === "game_end");
	const winner = result.winner;
	const winnerText =
		winner === "good" ? "好人阵营获胜" : winner === "wolf" ? "狼人阵营获胜" : "游戏中止";
	console.log("");
	console.log(
		`=== ${winnerText} · 第 ${result.days} 天 · ${result.events.length} 条事件 · ${(result.durationMs / 1000).toFixed(1)}s ===`,
	);
	if (end?.data?.roles) {
		const roles = end.data.roles as Record<string, string>;
		console.log(
			`身份：${Object.entries(roles)
				.sort(([a], [b]) => Number(a) - Number(b))
				.map(([seat, role]) => `${seatLabel(Number(seat))}${ROLE_LABEL[role as Role] ?? role}`)
				.join("、")}`,
		);
	}
	const totalUsage = Object.values(result.usageBySeat).reduce(
		(acc, usage) => ({
			input: acc.input + usage.input,
			output: acc.output + usage.output,
			total: acc.total + usage.total,
		}),
		{ input: 0, output: 0, total: 0 },
	);
	if (totalUsage.total > 0) {
		console.log(
			`模型用量：${totalUsage.total} tokens（输入 ${totalUsage.input} / 输出 ${totalUsage.output}；total 含缓存/推理）`,
		);
	}
	console.log(
		`异常统计：agent 错误 ${result.violations.agentErrors}，保底动作 ${result.violations.defaultActions}，规则拒绝 ${result.violations.ruleRejections}`,
	);
	console.log(`事件日志：${result.eventPath}`);
	console.log(`对局摘要：${result.summaryPath}`);
	console.log(`玩家上下文：${result.transcriptsDir}`);
}

async function main(): Promise<void> {
	const { values } = parseArgs(process.argv.slice(2));
	if (values.has("help")) {
		console.log(HELP);
		return;
	}
	const seed = stringArg({ values, positionals: [] }, "seed", Date.now().toString(36))!;
	const gameId = sanitizeId(
		stringArg({ values, positionals: [] }, "game-id", `${sanitizeId(seed)}-${Date.now().toString(36)}`)!,
	);
	const outDir = stringArg({ values, positionals: [] }, "out", join("runs", gameId))!;
	const scripted = boolArg({ values, positionals: [] }, "scripted");
	const showPrivate = boolArg({ values, positionals: [] }, "show-private");
	const verbose = boolArg({ values, positionals: [] }, "verbose");
	const quiet = boolArg({ values, positionals: [] }, "quiet");
	const modelSpec = stringArg({ values, positionals: [] }, "model");
	const thinking = stringArg({ values, positionals: [] }, "thinking", "low")!;
	const maxTokens = numberArg({ values, positionals: [] }, "max-tokens", 2000);
	const maxDays = numberArg({ values, positionals: [] }, "max-days", 30);
	const timeoutMs = numberArg({ values, positionals: [] }, "timeout", 240) * 1000;

	let loaded: LoadedModel | null = null;
	if (!scripted) {
		const { loadPiModel } = await import("../agents/model.ts");
		loaded = await loadPiModel({ model: modelSpec, thinkingLevel: thinking });
		console.log(
			`模型：${loaded.provider}/${loaded.modelId}（thinking: ${loaded.thinkingLevel}）`,
		);
	} else {
		console.log("模式：scripted（随机策略，不调用 LLM）");
	}

	const onEvent = (event: GameEvent): void => {
		if (quiet) return;
		if (event.visibility.kind === "public") {
			console.log(formatEvent(event));
			return;
		}
		if (showPrivate && event.visibility.kind === "seat") {
			console.log(`[私密→${seatLabel(event.visibility.seat)}] ${formatEvent(event)}`);
			return;
		}
		if (showPrivate && event.visibility.kind === "wolves") {
			console.log(`[狼队] ${formatEvent(event)}`);
			return;
		}
		if (verbose && event.visibility.kind === "judge") {
			console.log(`[法官] ${formatEvent(event)}`);
		}
	};

	const policyFactory = (seat: number, role: Role, engine: GameEngine): PlayerPolicy => {
		if (scripted) return new RandomPolicy(seat, seed);
		const pi = loaded;
		if (!pi) throw new Error("模型未初始化");
		return new PiPlayer({
			seat,
			role,
			model: pi.model,
			baseStreamFn: pi.runtime.streamSimple.bind(pi.runtime),
			sessionId: `${gameId}-seat-${seat}`,
			thinkingLevel: pi.thinkingLevel,
			maxTokens,
			limits: {
				maxSpeechChars: engine.config.maxSpeechChars,
				maxLastWordsChars: engine.config.maxLastWordsChars,
			},
			onEvent: verbose
				? (_seat, event: AgentEvent) => {
						if (event.type !== "tool_execution_end") return;
						const text = extractToolText(event.result);
						console.log(
							`  [${seatLabel(seat)}] ${event.toolName} ${event.isError ? "✗" : "✓"}${text ? ` ${truncate(text, 160)}` : ""}`,
						);
					}
				: undefined,
		});
	};

	const onTurn = verbose
		? (turn: TurnRequest, _view: PlayerView) => {
				console.log(`  [流程] 等待 ${seatLabel(turn.seat)} · ${turn.kind} · ${turn.id}`);
			}
		: undefined;

	try {
		const result = await runGame({
			seed,
			gameId,
			outDir,
			timeoutMs,
			policyFactory,
			onEvent,
			onTurn,
			config: { maxDays },
			metadata: {
				mode: scripted ? "scripted" : "pi-agent",
				model: loaded ? `${loaded.provider}/${loaded.modelId}` : null,
				thinkingLevel: loaded?.thinkingLevel ?? null,
			},
		});
		printSummary(result);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`\n游戏中止：${message}`);
		console.error(`部分日志：${join(outDir, "events.ndjson")}`);
		console.error(`对局摘要：${join(outDir, "summary.json")}`);
		if (!scripted) {
			console.error(
				"提示：若是模型不支持或鉴权问题，运行 `npm run doctor` 查看可用模型，并用 --model provider/model 指定。",
			);
			console.error("例如：--model openai-codex/gpt-5.6-luna");
		}
		process.exitCode = 1;
	}
}

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
exitAfterFlush();
