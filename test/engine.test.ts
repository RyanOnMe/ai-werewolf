import test from "node:test";
import assert from "node:assert/strict";
import { GameEngine } from "../src/engine/engine.ts";
import {
	type Action,
	type Role,
	type TurnRequest,
	RuleError,
} from "../src/engine/types.ts";

const FIXED_ROLES: Role[] = [
	"werewolf",
	"werewolf",
	"werewolf",
	"villager",
	"villager",
	"villager",
	"seer",
	"witch",
	"hunter",
];

function makeEngine(seed = "rules-test"): GameEngine {
	return GameEngine.create({ seed, gameId: `test-${seed}`, roles: FIXED_ROLES });
}

function playUntil(
	engine: GameEngine,
	stop: (turn: TurnRequest, engine: GameEngine) => boolean,
	handler: (turn: TurnRequest, engine: GameEngine) => Action,
): TurnRequest | null {
	let advanced = engine.advance();
	let guard = 0;
	while (advanced.turn) {
		guard += 1;
		if (guard > 2000) throw new Error("playUntil guard exceeded");
		const turn = advanced.turn;
		if (stop(turn, engine)) return turn;
		engine.submit(handler(turn, engine));
		advanced = engine.advance();
	}
	return null;
}

function lastPublicDeath(engine: GameEngine) {
	return [...engine.allEvents]
		.reverse()
		.find((e) => e.type === "death" && e.visibility.kind === "public");
}

test("开局身份数量正确，身份分配不进入公共视野", () => {
	const engine = makeEngine();
	const roles = engine.state.players.map((p) => p.role);
	assert.equal(roles.filter((r) => r === "werewolf").length, 3);
	assert.equal(roles.filter((r) => r === "villager").length, 3);
	assert.equal(roles.filter((r) => r === "seer").length, 1);
	assert.equal(roles.filter((r) => r === "witch").length, 1);
	assert.equal(roles.filter((r) => r === "hunter").length, 1);

	const seat4Events = engine.visibleEventsFor(4);
	assert.equal(seat4Events.some((e) => e.type === "role_assigned"), false);
	assert.equal(seat4Events.some((e) => e.type === "game_start"), true);

	const first = engine.advance();
	assert.equal(first.turn?.kind, "wolf_turn");
	assert.equal(first.turn?.seat, 1);
	assert.deepEqual(first.turn?.legalTargets, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("女巫用解药救下狼刀目标：平安夜，解药消耗", () => {
	const engine = makeEngine("save-night");
	const turn = playUntil(
		engine,
		(t) => t.kind === "day_speech",
		(t) => {
			switch (t.kind) {
				case "wolf_turn":
					return { kind: "wolf_turn", seat: t.seat, speech: "刀4号", vote: 4 };
				case "seer_check":
					return { kind: "seer_check", seat: t.seat, target: 1 };
				case "witch_act":
					return { kind: "witch_act", seat: t.seat, save: true, poisonTarget: null };
				default:
					throw new Error(`unexpected turn ${t.kind}`);
			}
		},
	);
	assert.equal(turn?.kind, "day_speech");
	assert.equal(engine.player(4).alive, true);
	assert.equal(engine.state.witch.antidote, false);
	assert.equal(engine.state.night.witchSave, true);
	assert.equal(lastPublicDeath(engine)?.text.includes("平安夜"), true);

	const seerResult = engine.allEvents.find((e) => e.type === "seer_result");
	assert.ok(seerResult);
	assert.equal(seerResult.visibility.kind, "seat");
	if (seerResult.visibility.kind === "seat") assert.equal(seerResult.visibility.seat, 7);
	assert.equal(engine.visibleEventsFor(7).includes(seerResult), true);
	assert.equal(engine.visibleEventsFor(4).includes(seerResult), false);
});

test("狼刀 + 女巫毒：两人死亡，公开播报不泄漏死因", () => {
	const engine = makeEngine("kill-poison");
	playUntil(
		engine,
		(t) => t.kind === "day_speech",
		(t) => {
			switch (t.kind) {
				case "wolf_turn":
					return { kind: "wolf_turn", seat: t.seat, speech: "", vote: 4 };
				case "seer_check":
					return { kind: "seer_check", seat: t.seat, target: 2 };
				case "witch_act":
					return { kind: "witch_act", seat: t.seat, save: false, poisonTarget: 5 };
				case "last_words":
					return { kind: "last_words", seat: t.seat, text: "我走了。" };
				default:
					throw new Error(`unexpected turn ${t.kind}`);
			}
		},
	);
	assert.equal(engine.player(4).alive, false);
	assert.equal(engine.player(5).alive, false);
	assert.deepEqual(engine.player(4).death?.causes, ["wolf_kill"]);
	assert.deepEqual(engine.player(5).death?.causes, ["poison"]);
	const publicDeath = lastPublicDeath(engine);
	assert.ok(publicDeath?.text.includes("4号") && publicDeath.text.includes("5号"));
	assert.equal(publicDeath?.text.includes("毒"), false);
	assert.equal(publicDeath?.text.includes("狼刀"), false);
	const judgeDeath = engine.allEvents.find(
		(e) => e.type === "death" && e.visibility.kind === "judge",
	);
	assert.ok(judgeDeath);
});

test("猎人被狼刀可以开枪，被毒杀不能开枪", () => {
	const engine = makeEngine("hunter-shot");
	const seen: string[] = [];
	playUntil(
		engine,
		(t) => t.kind === "day_speech",
		(t) => {
			seen.push(t.kind);
			switch (t.kind) {
				case "wolf_turn":
					return { kind: "wolf_turn", seat: t.seat, speech: "", vote: 9 };
				case "seer_check":
					return { kind: "seer_check", seat: t.seat, target: 1 };
				case "witch_act":
					return { kind: "witch_act", seat: t.seat, save: false, poisonTarget: null };
				case "last_words":
					return { kind: "last_words", seat: t.seat, text: "我是猎人。" };
				case "hunter_shoot":
					return { kind: "hunter_shoot", seat: t.seat, target: 4 };
				default:
					throw new Error(`unexpected turn ${t.kind}`);
			}
		},
	);
	assert.equal(seen.includes("hunter_shoot"), true);
	assert.equal(engine.player(9).alive, false);
	assert.equal(engine.player(4).alive, false);
	assert.deepEqual(engine.player(4).death?.causes, ["hunter_shot"]);
	assert.equal(
		engine.allEvents.some((e) => e.type === "hunter_shot" && e.visibility.kind === "public"),
		true,
	);

	const poisoned = makeEngine("hunter-poisoned");
	const seen2: string[] = [];
	playUntil(
		poisoned,
		(t) => t.kind === "day_speech",
		(t) => {
			seen2.push(t.kind);
			switch (t.kind) {
				case "wolf_turn":
					return { kind: "wolf_turn", seat: t.seat, speech: "", vote: "no_kill" };
				case "seer_check":
					return { kind: "seer_check", seat: t.seat, target: 1 };
				case "witch_act":
					return { kind: "witch_act", seat: t.seat, save: false, poisonTarget: 9 };
				case "last_words":
					return { kind: "last_words", seat: t.seat, text: "我走了。" };
				default:
					throw new Error(`unexpected turn ${t.kind}`);
			}
		},
	);
	assert.equal(seen2.includes("hunter_shoot"), false);
	assert.deepEqual(poisoned.player(9).death?.causes, ["poison"]);
});

test("投票平票时无人被放逐", () => {
	const engine = makeEngine("vote-tie");
	const votes: Record<number, number | "abstain"> = {
		1: 4,
		2: 4,
		3: 5,
		4: 5,
		5: "abstain",
		6: "abstain",
		7: "abstain",
		8: "abstain",
		9: "abstain",
	};
	playUntil(
		engine,
		(t, e) => t.kind === "wolf_turn" && e.state.day === 2,
		(t) => {
			switch (t.kind) {
				case "wolf_turn":
					return { kind: "wolf_turn", seat: t.seat, speech: "", vote: "no_kill" };
				case "seer_check":
					return { kind: "seer_check", seat: t.seat, target: 1 };
				case "witch_act":
					return { kind: "witch_act", seat: t.seat, save: false, poisonTarget: null };
				case "day_speech":
					return { kind: "day_speech", seat: t.seat, text: "我过。" };
				case "day_vote":
					return { kind: "day_vote", seat: t.seat, target: votes[t.seat] ?? "abstain" };
				default:
					throw new Error(`unexpected turn ${t.kind}`);
			}
		},
	);
	assert.equal(engine.state.day, 2);
	assert.equal(engine.aliveSeats().length, 9);
	const record = engine.allEvents.find((e) => e.type === "vote_record");
	assert.ok(record?.text.includes("平票"));
	assert.equal(engine.aliveSeats().includes(4), true);
});

test("规则校验：女巫不能同晚双药，预言家不能验自己", () => {
	const engine = makeEngine("invalid-actions");
	let advanced = engine.advance();
	assert.equal(advanced.turn?.kind, "wolf_turn");
	for (let seat = 1; seat <= 3; seat++) {
		const turn: TurnRequest | null = advanced.turn;
		assert.equal(turn?.seat, seat);
		engine.submit({ kind: "wolf_turn", seat, speech: "", vote: 4 });
		advanced = engine.advance();
	}
	assert.equal(advanced.turn?.kind, "seer_check");
	const seerTurn = advanced.turn!;
	assert.throws(
		() => engine.submit({ kind: "seer_check", seat: seerTurn.seat, target: seerTurn.seat }),
		(err: unknown) => err instanceof RuleError && err.code === "self_check",
	);
	engine.submit({ kind: "seer_check", seat: seerTurn.seat, target: 1 });
	advanced = engine.advance();
	assert.equal(advanced.turn?.kind, "witch_act");
	const witchTurn = advanced.turn!;
	assert.throws(
		() =>
			engine.submit({
				kind: "witch_act",
				seat: witchTurn.seat,
				save: true,
				poisonTarget: 5,
			}),
		(err: unknown) => err instanceof RuleError && err.code === "both_potions",
	);
	assert.equal(engine.state.witch.antidote, true);
	assert.equal(engine.state.witch.poison, true);
	engine.submit({ kind: "witch_act", seat: witchTurn.seat, save: false, poisonTarget: null });
});

test("胜负判定：屠边优先，狼人全灭优先于同归于尽", () => {
	const engine = makeEngine("win-check");
	for (const p of engine.state.players) {
		if (p.role === "werewolf") p.alive = false;
	}
	assert.equal(engine.computeWinner(), "good");

	const wolfWin = makeEngine("win-check-2");
	for (const p of wolfWin.state.players) {
		if (p.role === "villager") p.alive = false;
	}
	assert.equal(wolfWin.computeWinner(), "wolf");

	const godWin = makeEngine("win-check-3");
	for (const p of godWin.state.players) {
		if (p.role === "seer" || p.role === "witch" || p.role === "hunter") p.alive = false;
	}
	assert.equal(godWin.computeWinner(), "wolf");

	const both = makeEngine("win-check-4");
	for (const p of both.state.players) {
		if (p.role === "werewolf" || p.role === "villager") p.alive = false;
	}
	assert.equal(both.computeWinner(), "good");
});
