import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type Static, type TSchema } from "typebox";
import {
	type Action,
	type PlayerView,
	type TurnRequest,
	PHASE_LABEL,
	ROLE_LABEL,
	factionOf,
	seatLabel,
} from "../engine/types.ts";
import { formatEvent, formatSeatList } from "../judge/format.ts";
import { RULES_TEXT } from "./rules.ts";

export interface ToolLimits {
	maxSpeechChars: number;
	maxLastWordsChars: number;
}

export interface TurnHandle {
	turn: TurnRequest;
	view: PlayerView;
	action: Action | null;
	wolfSpeech: string[];
}

export function createTurnHandle(turn: TurnRequest, view: PlayerView): TurnHandle {
	return { turn, view, action: null, wolfSpeech: [] };
}

export const INFO_TOOL_NAMES = new Set(["view_state", "view_log", "view_rules"]);

interface ToolOutcome {
	text: string;
	details?: Record<string, unknown>;
}

function asResult(outcome: ToolOutcome): AgentToolResult<Record<string, unknown>> {
	return {
		content: [{ type: "text", text: outcome.text }],
		details: outcome.details ?? {},
	};
}

function reject(reason: string): ToolOutcome {
	return { text: `行动被拒绝：${reason}`, details: { accepted: false } };
}

function accept(handle: TurnHandle, action: Action, text: string): ToolOutcome {
	if (handle.action) return reject("本回合行动已经提交，不能再行动。");
	handle.action = action;
	return { text, details: { accepted: true, action } };
}

function makeTool<T extends TSchema>(
	handle: TurnHandle,
	name: string,
	label: string,
	description: string,
	parameters: T,
	run: (params: Static<T>) => ToolOutcome,
): AgentTool<T> {
	return {
		name,
		label,
		description,
		parameters,
		execute: async (_toolCallId, params) => asResult(run(params)),
	};
}

function isLegalTarget(handle: TurnHandle, target: number): boolean {
	return Number.isInteger(target) && handle.turn.legalTargets.includes(target);
}

function checkText(text: string, max: number): string | null {
	if (text.trim().length === 0) return "内容不能为空";
	if (text.length > max) return `内容不能超过 ${max} 字`;
	return null;
}

export function buildTurnTools(handle: TurnHandle, limits: ToolLimits): AgentTool<any>[] {
	const tools: AgentTool<any>[] = [];
	const turn = handle.turn;

	switch (turn.kind) {
		case "wolf_turn": {
			tools.push(
				makeTool(
					handle,
					"wolf_speak",
					"狼队频道发言",
					"在狼队私密频道发言，只有你和狼队友能看到。可以多次调用；发言完必须调用 wolf_vote 提交刀杀目标。",
					Type.Object({
						text: Type.String({
							minLength: 1,
							maxLength: limits.maxSpeechChars,
							description: "狼队频道发言内容，中文，简洁。",
						}),
					}),
					(params) => {
						if (handle.action) return reject("本回合行动已经提交。");
						const problem = checkText(params.text, limits.maxSpeechChars);
						if (problem) return reject(problem);
						handle.wolfSpeech.push(params.text);
						return { text: "已记录你的狼队发言。请继续调用 wolf_vote 提交刀杀投票。", details: { accepted: true } };
					},
				),
				makeTool(
					handle,
					"wolf_vote",
					"狼队刀杀投票",
					"提交狼队本夜的刀杀目标。必须选择一名存活玩家，或选择 no_kill 空刀。狼队内部平票会空刀。",
					Type.Object({
						target: Type.Union([Type.Integer({ minimum: 1 }), Type.Literal("no_kill")], {
							description: "存活的玩家座位号，或 no_kill。",
						}),
					}),
					(params) => {
						if (params.target !== "no_kill" && !isLegalTarget(handle, params.target)) {
							return reject(`目标 ${params.target} 不是本回合可刀杀的存活玩家。`);
						}
						return accept(
							handle,
							{
								kind: "wolf_turn",
								seat: turn.seat,
								speech: handle.wolfSpeech.join("\n"),
								vote: params.target,
							},
							params.target === "no_kill"
								? "已提交：本夜空刀。"
								: `已提交：刀杀 ${seatLabel(params.target)}。`,
						);
					},
				),
			);
			break;
		}
		case "seer_check": {
			tools.push(
				makeTool(
					handle,
					"seer_check",
					"预言家查验",
					"查验一名存活玩家的阵营。不能查验自己。你会得到“狼人”或“好人”的结果，结果只有你知道。",
					Type.Object({
						target: Type.Integer({ minimum: 1, description: "要查验的存活玩家座位号。" }),
					}),
					(params) => {
						if (!isLegalTarget(handle, params.target)) {
							return reject(`目标 ${params.target} 不是本回合可查验的存活玩家（不能查验自己或已出局玩家）。`);
						}
						return accept(
							handle,
							{ kind: "seer_check", seat: turn.seat, target: params.target },
							`已查验 ${seatLabel(params.target)}，结果将在法官私信中返回。`,
						);
					},
				),
			);
			break;
		}
		case "witch_act": {
			tools.push(
				makeTool(
					handle,
					"witch_act",
					"女巫用药",
					"决定今晚是否用药。save=true 使用解药救今晚被狼刀的目标；poisonTarget 使用毒药毒杀一名存活玩家；两者不能同时使用。都不使用则 save=false 且 poisonTarget=null。",
					Type.Object({
						save: Type.Boolean({ description: "是否使用解药救今晚被狼刀的目标。" }),
						poisonTarget: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], {
							description: "毒药目标座位号，或 null 表示不使用毒药。",
						}),
					}),
					(params) => {
						if (params.save && params.poisonTarget !== null) {
							return reject("同一晚不能同时使用解药和毒药。");
						}
						if (params.save && turn.canSave !== true) {
							return reject("今晚不能使用解药（可能已经用过、无人被刀，或你不能自救）。");
						}
						if (params.poisonTarget !== null) {
							if (turn.canPoison !== true) return reject("毒药已经用过了。");
							if (!isLegalTarget(handle, params.poisonTarget)) {
								return reject(`目标 ${params.poisonTarget} 不是可毒杀的存活玩家。`);
							}
						}
						const action: Action = {
							kind: "witch_act",
							seat: turn.seat,
							save: params.save,
							poisonTarget: params.poisonTarget,
						};
						const text = params.save
							? "已提交：使用解药。"
							: params.poisonTarget !== null
								? `已提交：使用毒药毒杀 ${seatLabel(params.poisonTarget)}。`
								: "已提交：今晚不用药。";
						return accept(handle, action, text);
					},
				),
			);
			break;
		}
		case "last_words": {
			tools.push(
				makeTool(
					handle,
					"last_words",
					"发表遗言",
					"你已出局。提交你的遗言，所有玩家都会看到。可以公布信息、指认狼人，也可以欺骗。",
					Type.Object({
						text: Type.String({
							minLength: 1,
							maxLength: limits.maxLastWordsChars,
							description: "遗言内容，中文。",
						}),
					}),
					(params) => {
						const problem = checkText(params.text, limits.maxLastWordsChars);
						if (problem) return reject(problem);
						return accept(
							handle,
							{ kind: "last_words", seat: turn.seat, text: params.text },
							"已提交遗言。",
						);
					},
				),
			);
			break;
		}
		case "hunter_shoot": {
			tools.push(
				makeTool(
					handle,
					"hunter_shoot",
					"猎人开枪",
					"你已出局且可以开枪。选择一名存活玩家带走，或传 target=null 放弃开枪。",
					Type.Object({
						target: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], {
							description: "要带走的存活玩家座位号，或 null 表示放弃。",
						}),
					}),
					(params) => {
						if (params.target !== null && !isLegalTarget(handle, params.target)) {
							return reject(`目标 ${params.target} 不是可开枪带走的存活玩家。`);
						}
						return accept(
							handle,
							{ kind: "hunter_shoot", seat: turn.seat, target: params.target },
							params.target === null
								? "已提交：放弃开枪。"
								: `已提交：开枪带走 ${seatLabel(params.target)}。`,
						);
					},
				),
			);
			break;
		}
		case "day_speech": {
			tools.push(
				makeTool(
					handle,
					"say",
					"公开发言",
					"提交本回合的公开发言，所有玩家都会看到。发言要有信息量，最多 500 字。不要输出工具语法。",
					Type.Object({
						text: Type.String({
							minLength: 1,
							maxLength: limits.maxSpeechChars,
							description: "公开发言内容，中文。",
						}),
					}),
					(params) => {
						const problem = checkText(params.text, limits.maxSpeechChars);
						if (problem) return reject(problem);
						return accept(
							handle,
							{ kind: "day_speech", seat: turn.seat, text: params.text },
							"已提交公开发言。",
						);
					},
				),
			);
			break;
		}
		case "day_vote": {
			tools.push(
				makeTool(
					handle,
					"vote",
					"放逐投票",
					"提交放逐投票。可以投给一名存活的其他玩家，或选择 abstain 弃票。不能投自己。",
					Type.Object({
						target: Type.Union([Type.Integer({ minimum: 1 }), Type.Literal("abstain")], {
							description: "要放逐的存活玩家座位号，或 abstain 弃票。",
						}),
					}),
					(params) => {
						if (params.target !== "abstain" && !isLegalTarget(handle, params.target)) {
							return reject(`目标 ${params.target} 不是本回合可投票的存活玩家（不能投自己）。`);
						}
						return accept(
							handle,
							{ kind: "day_vote", seat: turn.seat, target: params.target },
							params.target === "abstain"
								? "已提交：弃票。"
								: `已提交：投票给 ${seatLabel(params.target)}。`,
						);
					},
				),
			);
			break;
		}
	}

	tools.push(
		makeTool(
			handle,
			"view_state",
			"查看当前局势",
			"查看当前天数、阶段、存活/出局玩家、你的私密信息和本回合可行动目标。不消耗行动。",
			Type.Object({}),
			() => ({ text: renderState(handle) }),
		),
		makeTool(
			handle,
			"view_log",
			"查看历史事件",
			"查看你有权看到的最近历史事件（公开发言、投票、死亡、狼队频道、法官私信等）。不消耗行动。",
			Type.Object({
				lastN: Type.Optional(
					Type.Integer({ minimum: 1, maximum: 80, description: "查看最近多少条，默认 30。" }),
				),
			}),
			(params) => {
				const n = params.lastN ?? 30;
				const events = handle.view.visibleEvents.slice(-n);
				return {
					text:
						events.length === 0
							? "暂无可见事件。"
							: `最近 ${events.length} 条可见事件：\n${events.map(formatEvent).join("\n")}`,
				};
			},
		),
		makeTool(
			handle,
			"view_rules",
			"查看完整规则",
			"返回 9 人局的完整规则文本。不消耗行动。",
			Type.Object({}),
			() => ({ text: RULES_TEXT }),
		),
	);

	return tools;
}

function renderState(handle: TurnHandle): string {
	const view = handle.view;
	const lines: string[] = [];
	lines.push(
		`[法官] 第 ${view.day} 天 · ${PHASE_LABEL[view.phase]} · 回合 ${view.turn.id}`,
	);
	lines.push(
		`你是 ${seatLabel(view.seat)}，身份：${ROLE_LABEL[view.role]}（${factionOf(view.role) === "wolf" ? "狼人阵营" : "好人阵营"}），${view.alive ? "存活" : "已出局"}。`,
	);
	lines.push(`存活：${formatSeatList(view.aliveSeats)}；出局：${formatSeatList(view.deadSeats)}`);
	lines.push("私密信息：");
	for (const line of view.privateInfo) lines.push(`- ${line}`);
	lines.push(`本回合要求：${view.turn.promptHint}`);
	if (view.turn.legalTargets.length > 0) {
		lines.push(`可行动目标：${formatSeatList(view.turn.legalTargets)}`);
	}
	return lines.join("\n");
}
