import { type AgentEvent } from "@earendil-works/pi-agent-core";
import { type PlayerView, type TurnRequest } from "../engine/types.ts";
import { PiPlayer } from "./pi-player.ts";
import { loadPiModel } from "./model.ts";

export interface SmokeResult {
	model: string;
	speech: string;
	usage: { input: number; output: number; total: number };
	toolCalls: string[];
}

function smokeTurn(): TurnRequest {
	return {
		id: "SMOKE",
		kind: "day_speech",
		seat: 1,
		day: 1,
		phase: "day_discuss",
		legalTargets: [],
		promptHint: "轮到你发言。请调用 say 提交一句简短的中文发言。",
	};
}

function smokeView(turn: TurnRequest): PlayerView {
	const seats = [1, 2, 3, 4, 5, 6, 7, 8, 9];
		return {
			seat: 1,
			role: "villager",
			alive: true,
			mode: "9p",
			playerCount: 9,
			day: 1,
			phase: "day_discuss",
			players: seats.map((seat) => ({
				seat,
				alive: true,
				deathDay: null,
				deathPhase: null,
				revealed: false,
				canVote: true,
			})),
			aliveSeats: seats,
			deadSeats: [],
			sheriff: null,
			sheriffCandidates: [],
			sheriffVoteWeight: 1.5,
			legalTargets: [],
		privateInfo: ["你的身份：villager（好人阵营）", "状态：存活"],
		newEvents: [],
		visibleEvents: [],
		turn,
		brief: "[法官] 这是集成冒烟测试。轮到你发言，请调用 say 工具，用一句中文向其他玩家打招呼。",
	};
}

/** 真实模型的一次最小回合：验证 auth、pi agent loop、自定义工具。 */
export async function runSmoke(options: {
	model?: string;
	thinkingLevel?: string;
	onTool?: (name: string, accepted: boolean) => void;
}): Promise<SmokeResult> {
	const loaded = await loadPiModel({
		model: options.model,
		thinkingLevel: options.thinkingLevel,
	});
	const toolCalls: string[] = [];
	const player = new PiPlayer({
		seat: 1,
		role: "villager",
		model: loaded.model,
		baseStreamFn: loaded.runtime.streamSimple.bind(loaded.runtime),
		sessionId: `smoke-${Date.now().toString(36)}`,
		thinkingLevel: loaded.thinkingLevel,
		maxTokens: 1200,
		onEvent: (_seat, event: AgentEvent) => {
			if (event.type === "tool_execution_end") {
				toolCalls.push(event.toolName);
				options.onTool?.(event.toolName, !event.isError);
			}
		},
	});
	const turn = smokeTurn();
	try {
		const action = await player.decide(turn, smokeView(turn));
		if (action.kind !== "day_speech") {
			throw new Error(`冒烟测试期望 day_speech，实际 ${action.kind}`);
		}
		return {
			model: `${loaded.provider}/${loaded.modelId}`,
			speech: action.text,
			usage: player.usage(),
			toolCalls,
		};
	} finally {
		await player.dispose();
	}
}
