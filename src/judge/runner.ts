import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GameEngine } from "../engine/engine.ts";
import {
	type Action,
	type GameEvent,
	type PlayerPolicy,
	type PlayerView,
	type Role,
	type RulesConfig,
	type TurnRequest,
	type Winner,
	PHASE_LABEL,
} from "../engine/types.ts";
import { driveGame } from "./driver.ts";
import { defaultActionFor } from "./defaults.ts";
import { PiPlayerError } from "../agents/pi-player.ts";

export interface RunGameOptions {
	seed: string;
	gameId?: string;
	config?: Partial<RulesConfig>;
	/** 精确的 run 目录；提供后会写 events.ndjson / transcripts / summary.json。 */
	outDir?: string;
	timeoutMs?: number;
	policyFactory: (
		seat: number,
		role: Role,
		engine: GameEngine,
	) => PlayerPolicy | Promise<PlayerPolicy>;
	onEvent?: (event: GameEvent) => void;
	onTurn?: (turn: TurnRequest, view: PlayerView) => void;
	maxConsecutiveAgentErrors?: number;
	metadata?: Record<string, unknown>;
}

export interface GameViolations {
	agentErrors: number;
	defaultActions: number;
	ruleRejections: number;
}

export interface GameRunResult {
	gameId: string;
	seed: string;
	winner: Winner | null;
	endReason: string | null;
	days: number;
	events: readonly GameEvent[];
	eventPath: string;
	summaryPath: string;
	transcriptsDir: string;
	violations: GameViolations;
	usageBySeat: Record<number, { input: number; output: number; total: number }>;
	durationMs: number;
}

class RunRecorder {
	private readonly dir: string | null;

	constructor(dir: string | null) {
		this.dir = dir;
		if (dir) {
			mkdirSync(join(dir, "transcripts"), { recursive: true });
		}
	}

	event(event: GameEvent): void {
		if (!this.dir) return;
		appendFileSync(join(this.dir, "events.ndjson"), `${JSON.stringify(event)}\n`);
	}

	transcript(seat: number, data: unknown[]): void {
		if (!this.dir) return;
		const body = data.map((item) => JSON.stringify(item)).join("\n");
		writeFileSync(join(this.dir, "transcripts", `seat-${seat}.jsonl`), `${body}\n`);
	}

	summary(value: unknown): void {
		if (!this.dir) return;
		writeFileSync(join(this.dir, "summary.json"), `${JSON.stringify(value, null, 2)}\n`);
	}

	get path(): string {
		return this.dir ?? "";
	}
}

function sanitize(value: string, max = 60): string {
	const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return (cleaned || "game").slice(0, max);
}

function defaultGameId(seed: string): string {
	return `${sanitize(seed)}-${Date.now().toString(36)}`;
}

/**
 * 法官 runner：创建引擎、驱动玩家 policy、记录事件与 transcript。
 * 这里不做任何规则判断——规则全部在 GameEngine 里。
 */
export async function runGame(options: RunGameOptions): Promise<GameRunResult> {
	const gameId = options.gameId ?? defaultGameId(options.seed);
	const engine = GameEngine.create({
		seed: options.seed,
		gameId,
		config: options.config,
	});
	const policies = new Map<number, PlayerPolicy>();
	const started = Date.now();
	const recorder = new RunRecorder(options.outDir ?? null);
	const violations: GameViolations = {
		agentErrors: 0,
		defaultActions: 0,
		ruleRejections: 0,
	};
	const consecutiveErrors = new Map<number, number>();
	const maxConsecutive = options.maxConsecutiveAgentErrors ?? 5;
	let lastErrorTurnId: string | null = null;
	let failure: unknown = null;

	const recordJudge = (
		type: GameEvent["type"],
		text: string,
		data?: Record<string, unknown>,
	): GameEvent => {
		const event = engine.recordJudge(type, text, data);
		recorder.event(event);
		options.onEvent?.(event);
		return event;
	};

	// 开局事件（game_start / role_assigned）在 create() 时已经产生，
	// driveGame() 只返回本次 advance 产生的事件，所以这里要先落盘。
	for (const event of engine.allEvents) {
		recorder.event(event);
		options.onEvent?.(event);
	}

	try {
		for (const player of engine.state.players) {
			const policy = await options.policyFactory(player.seat, player.role, engine);
			policies.set(player.seat, policy);
		}

		await driveGame(engine, {
			policies,
			timeoutMs: options.timeoutMs,
			onEvents: (events) => {
				for (const event of events) {
					recorder.event(event);
					options.onEvent?.(event);
				}
			},
			onTurn: options.onTurn,
			onError: async (error, turn, view) => {
				const message = error instanceof Error ? error.message : String(error);
				const fatal = error instanceof PiPlayerError && error.fatal;
				violations.agentErrors += 1;
				lastErrorTurnId = turn.id;
				const count = (consecutiveErrors.get(turn.seat) ?? 0) + 1;
				consecutiveErrors.set(turn.seat, count);
				recordJudge("agent_error", `${turn.seat}号 ${turn.kind}: ${message}`, {
					seat: turn.seat,
					kind: turn.kind,
					turnId: turn.id,
					fatal,
					error: message,
				});
				if (fatal || count >= maxConsecutive) throw error;
				const action: Action = defaultActionFor(view);
				violations.defaultActions += 1;
				recordJudge("default_action", `${turn.seat}号 ${turn.kind} 使用保底动作`, {
					seat: turn.seat,
					kind: turn.kind,
					turnId: turn.id,
					action,
				});
				return action;
			},
			onRuleError: (error, turn) => {
				violations.ruleRejections += 1;
				recordJudge("action_rejected", `${turn.seat}号 ${turn.kind}: ${error.message}`, {
					seat: turn.seat,
					kind: turn.kind,
					turnId: turn.id,
					code: error.code,
					error: error.message,
				});
			},
			afterTurn: (turn) => {
				if (lastErrorTurnId !== turn.id) consecutiveErrors.delete(turn.seat);
			},
		});
	} catch (error) {
		failure = error;
	} finally {
		for (const [seat, policy] of policies) {
			if (!policy.transcript) continue;
			recorder.transcript(seat, policy.transcript());
		}
		const durationMs = Date.now() - started;
		const usageBySeat: Record<number, { input: number; output: number; total: number }> = {};
		for (const [seat, policy] of policies) {
			if (policy.usage) usageBySeat[seat] = policy.usage();
		}
		const summary = {
			gameId,
			seed: options.seed,
			createdAt: new Date().toISOString(),
			durationMs,
			playerCount: engine.state.players.length,
			winner: engine.state.winner,
			endReason: engine.state.endReason,
			days: engine.state.day,
			phase: engine.state.phase,
			phaseLabel: PHASE_LABEL[engine.state.phase],
			roles: Object.fromEntries(engine.state.players.map((p) => [p.seat, p.role])),
			deaths: Object.fromEntries(
				engine.state.players.filter((p) => p.death).map((p) => [p.seat, p.death]),
			),
			eventCount: engine.allEvents.length,
			violations,
			usageBySeat,
			metadata: options.metadata ?? {},
			aborted: failure !== null,
			error: failure instanceof Error ? failure.message : failure ? String(failure) : null,
		};
		recorder.summary(summary);
		for (const policy of policies.values()) {
			await policy.dispose?.();
		}
	}

	if (failure) throw failure;
	return {
		gameId,
		seed: options.seed,
		winner: engine.state.winner,
		endReason: engine.state.endReason,
		days: engine.state.day,
		events: engine.allEvents,
		eventPath: recorder.path ? join(recorder.path, "events.ndjson") : "",
		summaryPath: recorder.path ? join(recorder.path, "summary.json") : "",
		transcriptsDir: recorder.path ? join(recorder.path, "transcripts") : "",
		violations,
		usageBySeat: Object.fromEntries(
			[...policies.entries()]
				.filter(([, policy]) => policy.usage)
				.map(([seat, policy]) => [seat, policy.usage!()]),
		),
		durationMs: Date.now() - started,
	};
}
