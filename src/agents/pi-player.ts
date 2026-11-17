import {
	Agent,
	type AgentEvent,
	type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import {
	type Action,
	type GameMode,
	type PlayerPolicy,
	type PlayerProgress,
	type PlayerView,
	type Role,
	type TurnRequest,
	MAX_WOLF_PLAN_CHARS,
	isPublicSpeechTurn,
	seatLabel,
} from "../engine/types.ts";
import { isFatalModelError, withModelRetry, type RetryOptions } from "./model-stream.ts";
import { buildCorrectionPrompt, buildSystemPrompt, expectedTool } from "./rules.ts";
import {
	buildTurnTools,
	createTurnHandle,
	INFO_TOOL_NAMES,
	type ToolLimits,
	type TurnHandle,
} from "./tools.ts";

export class PiPlayerError extends Error {
	readonly fatal: boolean;
	readonly detail: unknown;

	constructor(message: string, fatal: boolean, detail?: unknown) {
		super(message);
		this.name = "PiPlayerError";
		this.fatal = fatal;
		this.detail = detail;
	}
}

export interface PiPlayerOptions {
	seat: number;
	role: Role;
	mode?: GameMode;
	model: Model<any>;
	baseStreamFn: StreamFn;
	sessionId: string;
	thinkingLevel?: ThinkingLevel;
	maxTokens?: number;
	limits?: Partial<ToolLimits>;
	/** 每个 prompt 内最多允许几个 agent turn（防止工具循环）。 */
	maxTurnsPerPrompt?: number;
	retry?: Partial<RetryOptions>;
	/** 进程内调试事件，含私密上下文，不能直接转发给观众。 */
	onEvent?: (seat: number, event: AgentEvent) => void;
}

const DEFAULT_LIMITS: ToolLimits = { maxSpeechChars: 500, maxLastWordsChars: 500 };

/**
 * 一个玩家 = 一个持久的 pi Agent 实例。
 *
 * - 上下文：system prompt（角色+规则） + 历次法官简报 + 自己的工具调用/结果。
 * - 行动：每回合只挂载本阶段合法的工具；工具闭包写入 TurnHandle.action。
 * - 终止：shouldStopAfterTurn 在 action 已提交时结束 agent loop。
 */
export class PiPlayer implements PlayerPolicy {
	readonly seat: number;
	readonly role: Role;
	private readonly agent: Agent;
	private readonly limits: ToolLimits;
	private readonly maxTurnsPerPrompt: number;
	private readonly onEvent?: (seat: number, event: AgentEvent) => void;
	private handle: TurnHandle | null = null;
	private onProgress?: (progress: PlayerProgress) => void;
	private turnsThisPrompt = 0;
	private lastAssistantError: string | null = null;
	private abortPromise: Promise<void> | null = null;
	private disposed = false;
	private totals = { input: 0, output: 0, total: 0 };

	constructor(options: PiPlayerOptions) {
		this.seat = options.seat;
		this.role = options.role;
		this.limits = { ...DEFAULT_LIMITS, ...options.limits };
		this.maxTurnsPerPrompt = options.maxTurnsPerPrompt ?? 10;
		this.onEvent = options.onEvent;
		const maxTokens = options.maxTokens ?? 2000;
		const streamFn: StreamFn = (model, context, streamOptions) => {
			const handle = this.handle;
			const turn = handle?.turn;
			const report = (progress: PlayerProgress): void => {
				if (this.handle === handle && !streamOptions?.signal?.aborted) this.onProgress?.(progress);
			};
			const previewTool = turn && isPublicSpeechTurn(turn.kind) ? expectedTool(turn.kind)
				: turn?.kind === "wolf_turn" ? "wolf_speak"
				: turn?.kind === "wolf_strategy" ? "set_wolf_plan" : null;
			const field = previewTool === "set_wolf_plan" ? "plan" : "text";
			const maxChars = field === "plan" ? MAX_WOLF_PLAN_CHARS
				: turn?.kind === "last_words" ? this.limits.maxLastWordsChars : this.limits.maxSpeechChars;
			let draftIndex: number | undefined;
			let previous = "";
			report({ state: "waiting" });
			return withModelRetry(options.baseStreamFn, options.retry, {
				onAttempt: () => report({ state: "waiting" }),
				onChunk: (event) => {
					if (!previewTool || !this.onProgress) return;
					const draft = speechDraft(event, previewTool, field);
					if (!draft || (draftIndex !== undefined && draftIndex !== draft.index)) return;
					const text = draft.text.slice(0, maxChars).replace(/[\uD800-\uDBFF]$/, "");
					if (!text.trim() || text === previous) return;
					draftIndex = draft.index;
					previous = text;
					report({ state: "streaming", text });
				},
				onRetry: (retry, usage) => {
					draftIndex = undefined;
					previous = "";
					this.addUsage(usage);
					report({ state: "retrying", retry });
				},
			})(model, context, { ...streamOptions, maxTokens });
		};
		this.agent = new Agent({
			initialState: {
				systemPrompt: buildSystemPrompt(options.role, options.seat, options.mode ?? "9p"),
				model: options.model,
				thinkingLevel: options.thinkingLevel ?? "low",
				tools: [],
			},
			streamFn,
			toolExecution: "sequential",
			sessionId: options.sessionId,
			shouldStopAfterTurn: () => {
				if (this.handle?.action) return true;
				this.turnsThisPrompt += 1;
				return this.turnsThisPrompt >= this.maxTurnsPerPrompt;
			},
			beforeToolCall: async ({ toolCall }) => {
				if (this.handle?.action && !INFO_TOOL_NAMES.has(toolCall.name)) {
					return { block: true, reason: "本回合行动已经提交，不能再调用行动工具。" };
				}
				return undefined;
			},
		});
		this.agent.subscribe((event) => this.handleEvent(event));
	}

	async decide(turn: TurnRequest, view: PlayerView, onProgress?: (progress: PlayerProgress) => void): Promise<Action> {
		if (this.disposed) throw new PiPlayerError("PiPlayer 已释放", true);
		if (this.abortPromise) await this.abortPromise;
		const handle = createTurnHandle(turn, view);
		this.handle = handle;
		this.onProgress = onProgress;
		this.turnsThisPrompt = 0;
		this.lastAssistantError = null;
		this.agent.state.tools = buildTurnTools(handle, this.limits);

		try {
			try {
				await this.agent.prompt(view.brief);
				if (!handle.action && !this.lastAssistantError) {
					this.turnsThisPrompt = 0;
					await this.agent.prompt(buildCorrectionPrompt(turn.kind));
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new PiPlayerError(
					`${seatLabel(this.seat)} 的 agent 调用失败：${message}`,
					isFatalModelError(message),
					error,
				);
			}

			if (!handle.action) {
				const message =
					this.lastAssistantError ??
					this.agent.state.errorMessage ??
					"agent 没有提交本回合行动";
				throw new PiPlayerError(
					`${seatLabel(this.seat)} 未提交行动：${message}`,
					isFatalModelError(message),
				);
			}
			return handle.action;
		} finally {
			this.handle = null;
			this.onProgress = undefined;
		}
	}

	abort(): void {
		if (this.disposed) return;
		this.agent.abort();
		const idle = this.agent.waitForIdle().catch(() => {});
		const promise = new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, 5000);
			idle.then(() => {
				clearTimeout(timer);
				resolve();
			});
		});
		this.abortPromise = promise;
		void promise.finally(() => {
			if (this.abortPromise === promise) this.abortPromise = null;
		});
	}

	transcript(): unknown[] {
		return [
			{ role: "system", content: this.agent.state.systemPrompt },
			...this.agent.state.messages,
		];
	}

	usage(): { input: number; output: number; total: number } {
		return { ...this.totals };
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		try {
			this.agent.abort();
		} catch {
			// ignore
		}
		// 防御性收尾：provider 的 stream/socket 偶尔不会自己结束。
		// 超过 2s 就放弃等待，CLI 会在 flush 后主动退出。
		const idle = this.agent.waitForIdle().catch(() => {});
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, 2000);
			idle.then(() => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	private handleEvent(event: AgentEvent): void {
		if (event.type === "message_end" && event.message.role === "assistant") {
			this.addUsage(event.message.usage);
			if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
				this.lastAssistantError = event.message.errorMessage ?? event.message.stopReason;
			}
		}
		this.onEvent?.(this.seat, event);
	}

	private addUsage(usage: AssistantMessage["usage"] | undefined): void {
		if (!usage) return;
		this.totals.input += usage.input;
		this.totals.output += usage.output;
		this.totals.total += usage.totalTokens;
	}
}

function speechDraft(event: AssistantMessageEvent, tool: string, field: string): { index: number; text: string } | null {
	if (event.type !== "toolcall_delta" && event.type !== "toolcall_end") return null;
	const block = event.type === "toolcall_end" ? event.toolCall : event.partial.content[event.contentIndex];
	if (block?.type !== "toolCall" || block.name !== tool) return null;
	const args = block.arguments;
	if (typeof args?.[field] !== "string" || Object.keys(args).length !== 1) return null;
	return { index: event.contentIndex, text: args[field] };
}
