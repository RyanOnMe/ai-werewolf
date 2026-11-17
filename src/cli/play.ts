import { join } from "node:path";
import { type AgentEvent } from "@earendil-works/pi-agent-core";
import {
	type GameEvent,
	type GameMode,
	type PlayerPolicy,
	type PlayerProgress,
	type PlayerView,
	type Role,
	type TurnRequest,
	ROLE_LABEL,
	isPublicSpeechTurn,
	seatLabel,
} from "../engine/types.ts";
import type { GameEngine } from "../engine/engine.ts";
import type { LoadedModel } from "../agents/model.ts";
import { assignmentSummary, splitModelSpecs } from "../agents/model-routing.ts";
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
  --mode <9p|12p>       板子（默认 9p；12p 含警长竞选与白痴）
  --scripted            使用无 LLM 的随机策略（不需要模型鉴权）
  --model <provider/id> 玩家模型，例如 paratera/DeepSeek-V4.1-Flash-1017
                        多个模型用逗号分隔，按座位轮流分配
  --models <list>       同 --model，可逗号分隔
  --thinking <level>    minimal|low|medium|high|xhigh|max（默认 low）
  --max-tokens <n>      每次模型输出上限（默认 2000）
  --max-days <n>        最大天数（默认 30）
  --timeout <seconds>   单回合超时（默认 240）
  --stream              逐段打印玩家公开发言草稿
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
	console.log(`板子：${result.mode === "12p" ? "12 人局（上警/白痴）" : "9 人局"}`);
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
	const board = stringArg({ values, positionals: [] }, "mode", "9p")!;
	if (board !== "9p" && board !== "12p") {
		throw new Error("--mode 必须是 9p 或 12p");
	}
	const gameMode: GameMode = board;
	const showPrivate = boolArg({ values, positionals: [] }, "show-private");
	const verbose = boolArg({ values, positionals: [] }, "verbose");
	const quiet = boolArg({ values, positionals: [] }, "quiet");
	const stream = !quiet && boolArg({ values, positionals: [] }, "stream");
	const modelSpec = stringArg({ values, positionals: [] }, "model");
	const modelsSpec = stringArg({ values, positionals: [] }, "models");
	const requestedModels = splitModelSpecs(modelsSpec ?? modelSpec);
	const thinking = stringArg({ values, positionals: [] }, "thinking", "low")!;
	const maxTokens = numberArg({ values, positionals: [] }, "max-tokens", 2000);
	const maxDays = numberArg({ values, positionals: [] }, "max-days", 30);
	const timeoutMs = numberArg({ values, positionals: [] }, "timeout", 240) * 1000;

	let loadedModels: LoadedModel[] = [];
	if (!scripted) {
		if (requestedModels.length > 0) {
			const { loadPiModels } = await import("../agents/model.ts");
			const set = await loadPiModels({ models: requestedModels, thinkingLevel: thinking });
			loadedModels = set.models;
		} else {
			const { loadPiModel } = await import("../agents/model.ts");
			loadedModels = [await loadPiModel({ thinkingLevel: thinking })];
		}
		const specs = loadedModels.map((model) => `${model.provider}/${model.modelId}`);
		console.log(`模型：${specs.join(" + ")}（thinking: ${loadedModels[0]!.thinkingLevel}）`);
		if (specs.length > 1) {
			console.log(`座位分配：${assignmentSummary(specs, gameMode === "12p" ? 12 : 9)}`);
		}
	} else {
		console.log("模式：scripted（随机策略，不调用 LLM）");
	}

	let draft = "";
	const finishDraft = (note = ""): void => {
		if (!draft) return;
		process.stdout.write(`${note}\n`);
		draft = "";
	};
	const onProgress = stream ? (turn: TurnRequest, progress: PlayerProgress): void => {
		const isWolf = turn.kind === "wolf_turn" || turn.kind === "wolf_strategy";
		if (!isPublicSpeechTurn(turn.kind) && !(showPrivate && isWolf)) return;
		if (progress.state === "retrying") {
			finishDraft("（草稿撤回）");
			console.log(`  [${seatLabel(turn.seat)}] ${progress.retry.delayMs}ms 后第 ${progress.retry.attempt} 次重试`);
			return;
		}
		if (progress.state === "waiting") {
			finishDraft("（草稿撤回）");
			return;
		}
		if (draft && !progress.text.startsWith(draft)) finishDraft("（草稿已更新）");
		if (!draft) process.stdout.write(`[${isWolf ? "狼队" : "发言"}草稿 · ${seatLabel(turn.seat)}] `);
		const delta = progress.text.slice(draft.length);
		process.stdout.write(delta.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ""));
		draft = progress.text;
	} : undefined;

	const onEvent = (event: GameEvent): void => {
		if (quiet) return;
		if (event.visibility.kind === "public") {
			finishDraft();
			console.log(formatEvent(event));
			return;
		}
		if (showPrivate && event.visibility.kind === "seat") {
			finishDraft();
			console.log(`[私密→${seatLabel(event.visibility.seat)}] ${formatEvent(event)}`);
			return;
		}
		if (showPrivate && event.visibility.kind === "wolves") {
			finishDraft();
			console.log(`[狼队] ${formatEvent(event)}`);
			return;
		}
		if (verbose && event.visibility.kind === "judge") {
			finishDraft();
			console.log(`[法官] ${formatEvent(event)}`);
		}
	};

	const policyFactory = (seat: number, role: Role, engine: GameEngine): PlayerPolicy => {
		if (scripted) return new RandomPolicy(seat, seed);
		const pi = loadedModels[(seat - 1) % loadedModels.length];
		if (!pi) throw new Error("模型未初始化");
		return new PiPlayer({
			seat,
			role,
			mode: engine.state.mode,
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
						finishDraft();
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
			mode: gameMode,
			outDir,
			timeoutMs,
			policyFactory,
			onEvent,
			onTurn,
			onProgress,
			onTurnSettled: stream ? () => finishDraft() : undefined,
			config: { maxDays },
			metadata: {
				mode: scripted ? "scripted" : "pi-agent",
				board: gameMode,
				model: loadedModels.length
					? loadedModels.map((model) => `${model.provider}/${model.modelId}`).join(",")
					: null,
				models: loadedModels.map((model) => `${model.provider}/${model.modelId}`),
				thinkingLevel: loadedModels[0]?.thinkingLevel ?? null,
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
			console.error("例如：--model paratera/DeepSeek-V4.1-Flash-1017");
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
