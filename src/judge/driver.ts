import {
	type Action,
	type GameEvent,
	type PlayerPolicy,
	type PlayerProgress,
	type PlayerView,
	type TurnRequest,
	RuleError,
} from "../engine/types.ts";
import type { GameEngine } from "../engine/engine.ts";
import { makePlayerView } from "../engine/engine.ts";
import { buildBrief } from "./brief.ts";
import { defaultActionFor } from "./defaults.ts";

export class TurnTimeoutError extends Error {
	readonly timeoutMs: number;
	constructor(timeoutMs: number) {
		super(`玩家行动超时（${timeoutMs}ms）`);
		this.name = "TurnTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

export interface DriveOptions {
	policies: Map<number, PlayerPolicy>;
	onEvents?: (events: readonly GameEvent[]) => void;
	onTurn?: (turn: TurnRequest, view: PlayerView) => void;
	onProgress?: (turn: TurnRequest, progress: PlayerProgress) => void;
	/** 无论提交成功、超时还是中止都调用，用于清除旁观草稿。 */
	onTurnSettled?: (turn: TurnRequest) => void;
	/** agent 抛错/超时时的保底动作；不提供则直接抛出。 */
	onError?: (error: unknown, turn: TurnRequest, view: PlayerView) => Promise<Action> | Action;
	/** 提交的动作被规则拒绝时调用；提供后使用合法保底动作继续。 */
	onRuleError?: (error: RuleError, turn: TurnRequest, view: PlayerView) => void;
	timeoutMs?: number;
	/** 每个回合结束回调，便于落盘 transcript。 */
	afterTurn?: (turn: TurnRequest, view: PlayerView, action: Action) => void;
}

async function decideWithTimeout(
	policy: PlayerPolicy,
	turn: TurnRequest,
	view: PlayerView,
	timeoutMs: number | undefined,
	onProgress?: (progress: PlayerProgress) => void,
): Promise<Action> {
	let timer: NodeJS.Timeout | undefined;
	let settled = false;
	try {
		const promise = policy.decide(turn, view, onProgress && ((progress) => {
			if (!settled) onProgress(progress);
		}));
		if (!timeoutMs || timeoutMs <= 0) return await promise;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				settled = true;
				policy.abort?.();
				reject(new TurnTimeoutError(timeoutMs));
			}, timeoutMs);
		});
		return await Promise.race([promise, timeout]);
	} finally {
		settled = true;
		if (timer) clearTimeout(timer);
	}
}

/** 驱动一局游戏直到结束。法官流程全部由 GameEngine 决定。 */
export async function driveGame(engine: GameEngine, options: DriveOptions): Promise<void> {
	const lastDelivered = new Map<number, number>();
	let steps = 0;
	while (true) {
		steps += 1;
		if (steps > 10_000) throw new Error("driveGame exceeded step guard");
		const advanced = engine.advance();
		if (advanced.events.length > 0) options.onEvents?.(advanced.events);
		const turn = advanced.turn;
		if (!turn) return;
		const policy = options.policies.get(turn.seat);
		if (!policy) throw new Error(`没有 ${turn.seat} 号玩家的 policy`);
		const view = makePlayerView(
			engine.state,
			engine.allEvents,
			turn,
			turn.seat,
			lastDelivered.get(turn.seat) ?? 0,
			engine.config.sheriffVoteWeight,
		);
		view.brief = buildBrief(view);
		try {
			options.onTurn?.(turn, view);
			let action: Action;
			try {
				action = await decideWithTimeout(
					policy, turn, view, options.timeoutMs,
					options.onProgress && ((progress) => options.onProgress?.(turn, progress)),
				);
			} catch (error) {
				if (!options.onError) throw error;
				action = await options.onError(error, turn, view);
			}

			const deliveredSeq = engine.allEvents.at(-1)?.seq ?? 0;
			try {
				const events = engine.submit(action);
				if (events.length > 0) options.onEvents?.(events);
			} catch (error) {
				if (!(error instanceof RuleError) || !options.onRuleError) throw error;
				options.onRuleError(error, turn, view);
				const fallback = defaultActionFor(view);
				const events = engine.submit(fallback);
				if (events.length > 0) options.onEvents?.(events);
				action = fallback;
			}
			lastDelivered.set(turn.seat, deliveredSeq);
			options.afterTurn?.(turn, view, action);
		} finally {
			options.onTurnSettled?.(turn);
		}
	}
}
