import test from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import {
	type PlayerView,
	type Role,
	type TurnKind,
	type TurnRequest,
	type Action,
} from "../src/engine/types.ts";
import { PiPlayer, PiPlayerError } from "../src/agents/pi-player.ts";
import { FAKE_MODEL, fakeStream, errorStream, type FakePlanner } from "./fake-llm.ts";

function makeTurn(
	kind: TurnKind,
	overrides: Partial<TurnRequest> = {},
): TurnRequest {
	const phaseByKind: Record<TurnKind, TurnRequest["phase"]> = {
		wolf_turn: "night_wolves",
		seer_check: "night_seer",
		witch_act: "night_witch",
		last_words: "last_words",
		hunter_shoot: "hunter_shot",
		sheriff_signup: "sheriff_signup",
		sheriff_speech: "sheriff_speech",
		sheriff_vote: "sheriff_vote",
		badge_transfer: "badge_transfer",
		day_speech: "day_discuss",
		day_vote: "day_vote",
	};
	const hints: Record<TurnKind, string> = {
		wolf_turn: "先 wolf_speak，再 wolf_vote。",
		seer_check: "请调用 seer_check。",
		witch_act: "请调用 witch_act。",
		last_words: "请调用 last_words。",
		hunter_shoot: "请调用 hunter_shoot。",
		sheriff_signup: "请调用 sheriff_run。",
		sheriff_speech: "请调用 sheriff_say。",
		sheriff_vote: "请调用 sheriff_vote。",
		badge_transfer: "请调用 transfer_badge。",
		day_speech: "请调用 say。",
		day_vote: "请调用 vote。",
	};
	return {
		id: "T1",
		kind,
		seat: 1,
		day: 1,
		phase: phaseByKind[kind],
		legalTargets: [],
		promptHint: hints[kind],
		...overrides,
	};
}

function makeView(turn: TurnRequest, role: Role): PlayerView {
	const alive =
		turn.kind !== "last_words" && turn.kind !== "hunter_shoot" && turn.kind !== "badge_transfer";
	return {
		seat: 1,
		role,
		alive,
		mode: "9p",
		playerCount: 9,
		day: 1,
		phase: turn.phase,
		players: Array.from({ length: 9 }, (_, index) => ({
			seat: index + 1,
			alive: index !== 0 || alive,
			deathDay: null,
			deathPhase: null,
			revealed: false,
			canVote: index !== 0 || alive,
		})),
		aliveSeats: alive ? [1, 2, 3, 4, 5, 6, 7, 8, 9] : [2, 3, 4, 5, 6, 7, 8, 9],
		deadSeats: alive ? [] : [1],
		sheriff: null,
		sheriffCandidates: [],
		sheriffVoteWeight: 1.5,
		legalTargets: turn.legalTargets,
		privateInfo: [`你的身份：${role}`, `状态：${alive ? "存活" : "已出局"}`],
		newEvents: [],
		visibleEvents: [],
		turn,
		brief: `[法官] 测试简报。${turn.promptHint}`,
	};
}

interface TurnResult {
	action: Action;
	toolSets: string[][];
	events: AgentEvent[];
	transcript: unknown[];
}

async function runTurn(
	kind: TurnKind,
	role: Role,
	planner: FakePlanner,
	overrides: Partial<TurnRequest> = {},
): Promise<TurnResult> {
	const turn = makeTurn(kind, overrides);
	const toolSets: string[][] = [];
	const events: AgentEvent[] = [];
	const player = new PiPlayer({
		seat: 1,
		role,
		model: FAKE_MODEL,
		baseStreamFn: fakeStream((context, index) => {
			toolSets.push(context.tools?.map((tool) => tool.name) ?? []);
			return planner(context, index);
		}),
		sessionId: `test-${kind}`,
		onEvent: (_seat, event) => events.push(event),
	});
	try {
		const action = await player.decide(turn, makeView(turn, role));
		return { action, toolSets, events, transcript: player.transcript() };
	} finally {
		await player.dispose();
	}
}

test("PiPlayer 通过 say 工具提交公开发言", async () => {
	const result = await runTurn("day_speech", "villager", () => ({
		name: "say",
		args: { text: "大家好，我是1号，先听一圈。" },
	}));
	assert.deepEqual(result.action, {
		kind: "day_speech",
		seat: 1,
		text: "大家好，我是1号，先听一圈。",
	});
	assert.equal(result.toolSets[0]?.includes("say"), true);
	assert.equal(result.toolSets[0]?.includes("vote"), false);
	const toolResults = result.transcript.filter(
		(message) => (message as { role?: string }).role === "toolResult",
	);
	assert.equal(toolResults.length, 1);
});

test("先调用 view_state 再行动，agent loop 会继续", async () => {
	const result = await runTurn("day_speech", "villager", (context) => {
		const last = context.messages.at(-1);
		if (last?.role === "toolResult") {
			return { name: "say", args: { text: "我看完局势了。" } };
		}
		return { name: "view_state", args: {} };
	});
	assert.deepEqual(result.action, {
		kind: "day_speech",
		seat: 1,
		text: "我看完局势了。",
	});
	assert.equal(result.toolSets.length, 2);
	assert.equal(result.toolSets[0]?.includes("view_state"), true);
	const toolResults = result.transcript.filter(
		(message) => (message as { role?: string }).role === "toolResult",
	) as { content: { type: string; text?: string }[] }[];
	assert.equal(toolResults.length, 2);
	assert.equal(toolResults[0]?.content[0]?.text?.includes("私密信息"), true);
});

test("非法投票目标被工具拒绝后，模型可以重试", async () => {
	const result = await runTurn(
		"day_vote",
		"villager",
		(context) => {
			const calls = context.messages.flatMap((message) =>
				message.role === "assistant"
					? message.content.filter((content) => content.type === "toolCall")
					: [],
			);
			const votes = calls.filter((call) => call.name === "vote").length;
			return votes === 0
				? { name: "vote", args: { target: 99 } }
				: { name: "vote", args: { target: 3 } };
		},
		{ legalTargets: [2, 3, 4, 5, 6, 7, 8, 9] },
	);
	assert.deepEqual(result.action, { kind: "day_vote", seat: 1, target: 3 });
	const transcript = JSON.stringify(result.transcript);
	assert.equal(transcript.includes("行动被拒绝"), true);
});

test("模型只输出文字时，法官发送纠正提示后继续", async () => {
	const result = await runTurn("day_speech", "villager", (context) => {
		const last = context.messages.at(-1);
		const lastText =
			last?.role === "user"
				? typeof last.content === "string"
					? last.content
					: last.content
							.filter((part) => part.type === "text")
							.map((part) => (part.type === "text" ? part.text : ""))
							.join("")
				: "";
		if (lastText.includes("还没有提交本回合的有效行动")) {
			return { name: "say", args: { text: "我补充一句：我怀疑2号。" } };
		}
		return { text: "我先想想，不着急发言。" };
	});
	assert.deepEqual(result.action, {
		kind: "day_speech",
		seat: 1,
		text: "我补充一句：我怀疑2号。",
	});
	assert.equal(
		JSON.stringify(result.transcript).includes("还没有提交本回合的有效行动"),
		true,
	);
});

test("始终不提交行动会抛出 PiPlayerError", async () => {
	await assert.rejects(
		() =>
			runTurn("day_speech", "villager", () => ({
				text: "我就是不调用工具。",
			})),
		(error: unknown) =>
			error instanceof PiPlayerError && error.message.includes("未提交行动"),
	);
});

test("狼人先 wolf_speak 再 wolf_vote，发言自动合并", async () => {
	const result = await runTurn(
		"wolf_turn",
		"werewolf",
		(context) => {
			const calls = context.messages.flatMap((message) =>
				message.role === "assistant"
					? message.content.filter((content) => content.type === "toolCall")
					: [],
			);
			const spoke = calls.some((call) => call.name === "wolf_speak");
			return spoke
				? { name: "wolf_vote", args: { target: 4 } }
				: { name: "wolf_speak", args: { text: "我想刀4号。" } };
		},
		{ legalTargets: [1, 2, 3, 4, 5, 6, 7, 8, 9], wolfTeammates: [2, 3] },
	);
	assert.deepEqual(result.action, {
		kind: "wolf_turn",
		seat: 1,
		speech: "我想刀4号。",
		vote: 4,
	});
	assert.equal(result.toolSets[0]?.includes("wolf_speak"), true);
	assert.equal(result.toolSets[0]?.includes("wolf_vote"), true);
	assert.equal(result.toolSets[0]?.includes("say"), false);
});

test("同一回合重复行动会被 beforeToolCall 阻止", async () => {
	const result = await runTurn("day_speech", "villager", () => ({
		calls: [
			{ name: "say", args: { text: "第一句。" } },
			{ name: "say", args: { text: "第二句。" } },
		],
	}));
	assert.deepEqual(result.action, {
		kind: "day_speech",
		seat: 1,
		text: "第一句。",
	});
	assert.equal(
		JSON.stringify(result.transcript).includes("本回合行动已经提交"),
		true,
	);
});

test("不同回合只暴露合法工具，并组装对应 Action", async () => {
	const cases: {
		kind: TurnKind;
		role: Role;
		planner: FakePlanner;
		overrides?: Partial<TurnRequest>;
		expected: Action;
		mustHave: string[];
		mustNotHave: string[];
	}[] = [
		{
			kind: "seer_check",
			role: "seer",
			planner: () => ({ name: "seer_check", args: { target: 2 } }),
			overrides: { legalTargets: [2, 3, 4, 5, 6, 7, 8, 9] },
			expected: { kind: "seer_check", seat: 1, target: 2 },
			mustHave: ["seer_check", "view_state"],
			mustNotHave: ["say", "vote", "wolf_vote"],
		},
		{
			kind: "witch_act",
			role: "witch",
			planner: () => ({ name: "witch_act", args: { save: true, poisonTarget: null } }),
			overrides: {
				legalTargets: [2, 3, 4, 5, 6, 7, 8, 9],
				canSave: true,
				canPoison: true,
				witchVictim: 3,
			},
			expected: { kind: "witch_act", seat: 1, save: true, poisonTarget: null },
			mustHave: ["witch_act"],
			mustNotHave: ["say", "seer_check"],
		},
		{
			kind: "hunter_shoot",
			role: "hunter",
			planner: () => ({ name: "hunter_shoot", args: { target: 2 } }),
			overrides: { legalTargets: [2, 3, 4, 5, 6, 7, 8, 9] },
			expected: { kind: "hunter_shoot", seat: 1, target: 2 },
			mustHave: ["hunter_shoot"],
			mustNotHave: ["say", "vote"],
		},
		{
			kind: "last_words",
			role: "villager",
			planner: () => ({ name: "last_words", args: { text: "好人加油。" } }),
			expected: { kind: "last_words", seat: 1, text: "好人加油。" },
			mustHave: ["last_words"],
			mustNotHave: ["say", "vote", "wolf_vote"],
		},
	];

	for (const item of cases) {
		const result = await runTurn(item.kind, item.role, item.planner, item.overrides);
		assert.deepEqual(result.action, item.expected, item.kind);
		for (const name of item.mustHave) {
			assert.equal(result.toolSets[0]?.includes(name), true, `${item.kind} 缺少 ${name}`);
		}
		for (const name of item.mustNotHave) {
			assert.equal(result.toolSets[0]?.includes(name), false, `${item.kind} 不应有 ${name}`);
		}
	}
});

test("模型错误会标记为 fatal，交由 runner 终止或降级", async () => {
	const turn = makeTurn("day_speech");
	const player = new PiPlayer({
		seat: 1,
		role: "villager",
		model: FAKE_MODEL,
		baseStreamFn: errorStream("model not supported for this account"),
		sessionId: "fatal-test",
	});
	try {
		await assert.rejects(
			() => player.decide(turn, makeView(turn, "villager")),
			(error: unknown) =>
				error instanceof PiPlayerError &&
				error.fatal &&
				error.message.includes("not supported"),
		);
	} finally {
		await player.dispose();
	}
});

test("警长竞选：sheriff_run 提交上警决定", async () => {
	const result = await runTurn("sheriff_signup", "villager", () => ({
		name: "sheriff_run",
		args: { run: true },
	}));
	assert.deepEqual(result.action, { kind: "sheriff_signup", seat: 1, run: true });
	assert.equal(result.toolSets[0]?.includes("sheriff_run"), true);
});

test("警长竞选：sheriff_say 与 sheriff_vote 走对应工具", async () => {
	const speech = await runTurn("sheriff_speech", "villager", () => ({
		name: "sheriff_say",
		args: { text: "我上警，警徽流先验2号。" },
	}));
	assert.deepEqual(speech.action, {
		kind: "sheriff_speech",
		seat: 1,
		text: "我上警，警徽流先验2号。",
	});

	const vote = await runTurn(
		"sheriff_vote",
		"villager",
		() => ({ name: "sheriff_vote", args: { target: 3 } }),
		{ legalTargets: [2, 3], sheriffCandidates: [2, 3] },
	);
	assert.deepEqual(vote.action, { kind: "sheriff_vote", seat: 1, target: 3 });
});

test("警徽移交：transfer_badge 支持交人或销毁", async () => {
	const result = await runTurn(
		"badge_transfer",
		"villager",
		() => ({ name: "transfer_badge", args: { target: 4 } }),
		{ legalTargets: [4, 5] },
	);
	assert.deepEqual(result.action, { kind: "badge_transfer", seat: 1, target: 4 });
	assert.equal(result.toolSets[0]?.includes("transfer_badge"), true);
});

test("view_strategy 可读取本局角色策略并继续行动", async () => {
	const result = await runTurn("day_speech", "werewolf", (_context, index) =>
		index === 0
			? { name: "view_strategy", args: {} }
			: { name: "say", args: { text: "我按狼队计划先站边，晚上再处理关键位。" } },
	);
	assert.equal(result.toolSets[0]?.includes("view_strategy"), true);
	assert.equal(result.toolSets[1]?.includes("say"), true);
	assert.deepEqual(result.action, {
		kind: "day_speech",
		seat: 1,
		text: "我按狼队计划先站边，晚上再处理关键位。",
	});
});
