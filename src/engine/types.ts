/** 领域类型：只描述狼人杀本身，不依赖任何 LLM / pi 类型。 */

export type Role = "werewolf" | "villager" | "seer" | "witch" | "hunter";
export type Faction = "wolf" | "good";
export type Winner = Faction;

export type Phase =
	| "setup"
	| "night_wolves"
	| "night_seer"
	| "night_witch"
	| "dawn"
	| "last_words"
	| "hunter_shot"
	| "day_discuss"
	| "day_vote"
	| "ended";

export const PHASE_LABEL: Record<Phase, string> = {
	setup: "准备",
	night_wolves: "夜晚·狼人行动",
	night_seer: "夜晚·预言家行动",
	night_witch: "夜晚·女巫行动",
	dawn: "天亮",
	last_words: "遗言",
	hunter_shot: "猎人开枪",
	day_discuss: "白天讨论",
	day_vote: "白天投票",
	ended: "游戏结束",
};

export const ROLE_LABEL: Record<Role, string> = {
	werewolf: "狼人",
	villager: "村民",
	seer: "预言家",
	witch: "女巫",
	hunter: "猎人",
};

export type DeathCause = "wolf_kill" | "poison" | "exile" | "hunter_shot";

export interface DeathRecord {
	day: number;
	phase: Phase;
	causes: DeathCause[];
}

export interface PlayerState {
	seat: number;
	role: Role;
	alive: boolean;
	death: DeathRecord | null;
}

export interface SeerCheck {
	day: number;
	target: number;
	result: Faction;
}

export interface NightState {
	wolfVotes: Record<number, number | "no_kill">;
	wolfTarget: number | null;
	seerTarget: number | null;
	seerResult: Faction | null;
	witchSave: boolean;
	witchPoison: number | null;
}

export interface GameState {
	gameId: string;
	seed: string;
	day: number;
	phase: Phase;
	players: PlayerState[];
	witch: { antidote: boolean; poison: boolean };
	night: NightState;
	seerChecks: SeerCheck[];
	dayStartSeat: number | null;
	votes: Record<number, number | "abstain">;
	winner: Winner | null;
	endReason: string | null;
}

export type Visibility =
	| { kind: "public" }
	| { kind: "seat"; seat: number }
	| { kind: "wolves" }
	| { kind: "judge" };

export type EventType =
	| "game_start"
	| "role_assigned"
	| "phase"
	| "speech"
	| "last_words"
	| "wolf_speech"
	| "wolf_vote"
	| "wolf_target"
	| "seer_result"
	| "witch_info"
	| "witch_action"
	| "vote_cast"
	| "vote_record"
	| "death"
	| "hunter_shot"
	| "game_end"
	| "action_rejected"
	| "agent_error"
	| "default_action"
	| "turn_start";

export interface GameEvent {
	seq: number;
	ts: string;
	gameId: string;
	day: number;
	phase: Phase;
	type: EventType;
	visibility: Visibility;
	actor: number | null;
	target: number | null;
	text: string;
	data?: Record<string, unknown>;
}

export type TurnKind =
	| "wolf_turn"
	| "seer_check"
	| "witch_act"
	| "last_words"
	| "hunter_shoot"
	| "day_speech"
	| "day_vote";

export interface TurnRequest {
	id: string;
	kind: TurnKind;
	seat: number;
	day: number;
	phase: Phase;
	/** 允许选择的目标座位；空数组表示该行动没有目标。 */
	legalTargets: number[];
	/** 法官给玩家的动作要求，写在 brief 末尾。 */
	promptHint: string;
	wolfTeammates?: number[];
	canSave?: boolean;
	canPoison?: boolean;
	canSelfSave?: boolean;
	witchVictim?: number | null;
}

export type Action =
	| { kind: "wolf_turn"; seat: number; speech: string; vote: number | "no_kill" }
	| { kind: "seer_check"; seat: number; target: number }
	| { kind: "witch_act"; seat: number; save: boolean; poisonTarget: number | null }
	| { kind: "last_words"; seat: number; text: string }
	| { kind: "hunter_shoot"; seat: number; target: number | null }
	| { kind: "day_speech"; seat: number; text: string }
	| { kind: "day_vote"; seat: number; target: number | "abstain" };

export interface RulesConfig {
	playerCount: number;
	maxSpeechChars: number;
	maxLastWordsChars: number;
	maxDays: number;
	/** 女巫是否只能第一夜自救。 */
	selfSaveNight1Only: boolean;
	allowWolfSelfKill: boolean;
	allowSelfVote: boolean;
	allowAbstain: boolean;
}

export const DEFAULT_CONFIG: RulesConfig = {
	playerCount: 9,
	maxSpeechChars: 500,
	maxLastWordsChars: 500,
	maxDays: 30,
	selfSaveNight1Only: true,
	allowWolfSelfKill: true,
	allowSelfVote: false,
	allowAbstain: true,
};

export interface PublicPlayerInfo {
	seat: number;
	alive: boolean;
	deathDay: number | null;
	deathPhase: Phase | null;
}

export interface PlayerView {
	seat: number;
	role: Role;
	alive: boolean;
	day: number;
	phase: Phase;
	players: PublicPlayerInfo[];
	aliveSeats: number[];
	deadSeats: number[];
	legalTargets: number[];
	privateInfo: string[];
	/** 自上次该玩家行动以来，新增的可见事件（已排除自己的行动回声）。 */
	newEvents: GameEvent[];
	/** 该玩家有权查看的全部事件，用于 view_log。 */
	visibleEvents: GameEvent[];
	turn: TurnRequest;
	brief: string;
}

export interface PlayerPolicy {
	readonly seat: number;
	decide(turn: TurnRequest, view: PlayerView): Promise<Action>;
	abort?(): void;
	transcript?(): unknown[];
	usage?(): { input: number; output: number; total: number };
	dispose?(): Promise<void> | void;
}

export function factionOf(role: Role): Faction {
	return role === "werewolf" ? "wolf" : "good";
}

export function isGod(role: Role): boolean {
	return role === "seer" || role === "witch" || role === "hunter";
}

export function seatLabel(seat: number): string {
	return `${seat}号`;
}

export class RuleError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "RuleError";
		this.code = code;
	}
}
