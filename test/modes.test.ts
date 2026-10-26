import test from "node:test";
import assert from "node:assert/strict";
import { GameEngine } from "../src/engine/engine.ts";
import {
	type Action,
	type Role,
	type TurnRequest,
	canVote,
	isGod,
} from "../src/engine/types.ts";

const ROLES_12: Role[] = [
	"villager",
	"villager",
	"villager",
	"villager",
	"werewolf",
	"werewolf",
	"werewolf",
	"werewolf",
	"seer",
	"witch",
	"hunter",
	"idiot",
];

function make12(seed: string, sheriffEnabled = true): GameEngine {
	return GameEngine.create({
		seed,
		gameId: `modes-${seed}`,
		mode: "12p",
		roles: ROLES_12,
		config: { sheriffEnabled },
	});
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
		if (guard > 4000) throw new Error("playUntil guard exceeded");
		const turn = advanced.turn;
		if (stop(turn, engine)) return turn;
		engine.submit(handler(turn, engine));
		advanced = engine.advance();
	}
	return null;
}

function baseAction(turn: TurnRequest, engine: GameEngine): Action {
	switch (turn.kind) {
		case "wolf_turn":
			return { kind: "wolf_turn", seat: turn.seat, speech: "", vote: "no_kill" };
		case "seer_check":
			return { kind: "seer_check", seat: turn.seat, target: 5 };
		case "witch_act":
			return { kind: "witch_act", seat: turn.seat, save: false, poisonTarget: null };
		case "sheriff_signup":
			return { kind: "sheriff_signup", seat: turn.seat, run: false };
		case "sheriff_speech":
			return { kind: "sheriff_speech", seat: turn.seat, text: "我上警带队。" };
		case "sheriff_vote":
			return { kind: "sheriff_vote", seat: turn.seat, target: "abstain" };
		case "badge_transfer":
			return { kind: "badge_transfer", seat: turn.seat, target: 4 };
		case "last_words":
			return { kind: "last_words", seat: turn.seat, text: "我先走了。" };
		case "hunter_shoot":
			return { kind: "hunter_shoot", seat: turn.seat, target: null };
		case "day_speech":
			return {
				kind: "day_speech",
				seat: turn.seat,
				text: `我是${turn.seat}号，今天先听一圈再归票。`,
			};
		case "day_vote":
			return { kind: "day_vote", seat: turn.seat, target: "abstain" };
	}
}

test("12 人局：4狼4民4神，白痴计入神职，身份不进入公共视野", () => {
	const engine = make12("setup-12");
	const roles = engine.state.players.map((p) => p.role);
	assert.equal(roles.filter((r) => r === "werewolf").length, 4);
	assert.equal(roles.filter((r) => r === "villager").length, 4);
	assert.equal(roles.filter((r) => r === "seer").length, 1);
	assert.equal(roles.filter((r) => r === "witch").length, 1);
	assert.equal(roles.filter((r) => r === "hunter").length, 1);
	assert.equal(roles.filter((r) => r === "idiot").length, 1);
	assert.equal(isGod("idiot"), true);

	const start = engine.allEvents[0]!;
	assert.equal(start.type, "game_start");
	assert.equal(start.data?.playerCount, 12);
	assert.equal(start.data?.mode, "12p");
	assert.equal(
		engine.visibleEventsFor(12).some((event) => event.type === "role_assigned"),
		false,
	);
	const first = engine.advance();
	assert.equal(first.turn?.kind, "wolf_turn");
	assert.equal(first.turn?.seat, 5);
});

test("12 人局：上警竞选、警长 1.5 票、夜间死亡无遗言、警徽移交", () => {
	const engine = make12("sheriff-night");
	let lastWordsForSheriff = false;
	const turn = playUntil(
		engine,
		(t, e) => t.kind === "day_speech" && e.state.day === 2,
		(t, e) => {
			if (t.kind === "wolf_turn") {
				return {
					kind: "wolf_turn",
					seat: t.seat,
					speech: "",
					vote: e.state.day === 1 ? "no_kill" : 1,
				};
			}
			if (t.kind === "sheriff_signup") {
				return { kind: "sheriff_signup", seat: t.seat, run: t.seat <= 2 };
			}
			if (t.kind === "sheriff_vote") {
				return { kind: "sheriff_vote", seat: t.seat, target: 1 };
			}
			return baseAction(t, e);
		},
	);
	assert.equal(turn?.kind, "day_speech");
	assert.equal(engine.state.day, 2);
	assert.equal(engine.state.sheriff, 4);
	assert.equal(engine.player(1).alive, false);
	assert.equal(
		engine.allEvents.some((event) => event.type === "last_words" && event.actor === 1),
		false,
	);
	lastWordsForSheriff = engine.allEvents.some(
		(event) => event.type === "last_words" && event.actor === 1,
	);
	assert.equal(lastWordsForSheriff, false);
	const badge = engine.allEvents.find(
		(event) => event.type === "badge_transfer" && event.data?.from === 1,
	);
	assert.ok(badge);
	assert.equal(badge?.target, 4);
	assert.equal(
		engine.allEvents.some(
			(event) => event.type === "sheriff_elected" && event.visibility.kind === "public",
		),
		true,
	);
});

test("12 人局：警长票权 1.5 计入放逐票，被放逐者留遗言", () => {
	const engine = make12("sheriff-weight");
	playUntil(
		engine,
		(t, e) => t.kind === "wolf_turn" && e.state.day === 2,
		(t, e) => {
			if (t.kind === "wolf_turn") {
				return { kind: "wolf_turn", seat: t.seat, speech: "", vote: "no_kill" };
			}
			if (t.kind === "sheriff_signup") {
				return { kind: "sheriff_signup", seat: t.seat, run: t.seat <= 2 };
			}
			if (t.kind === "sheriff_vote") {
				return { kind: "sheriff_vote", seat: t.seat, target: 1 };
			}
			if (t.kind === "day_vote") {
				return {
					kind: "day_vote",
					seat: t.seat,
					target: t.seat === 3 ? "abstain" : 3,
				};
			}
			return baseAction(t, e);
		},
	);
	assert.equal(engine.state.sheriff, 1);
	const record = engine.allEvents.find((event) => event.type === "vote_record");
	assert.ok(record);
	const tally = record?.data?.tally as Record<string, number>;
	assert.equal(tally["3"], 11.5);
	assert.equal(record?.data?.exiled, 3);
	assert.equal(
		engine.allEvents.some((event) => event.type === "last_words" && event.actor === 3),
		true,
	);
});

test("12 人局：白痴首次被放逐翻牌免死、失去投票权，仍算存活神职", () => {
	const engine = make12("idiot-reveal", false);
	playUntil(
		engine,
		(t, e) => t.kind === "wolf_turn" && e.state.day === 2,
		(t, e) => {
			if (t.kind === "wolf_turn") {
				return { kind: "wolf_turn", seat: t.seat, speech: "", vote: "no_kill" };
			}
			if (t.kind === "day_vote") {
				return {
					kind: "day_vote",
					seat: t.seat,
					target: t.seat === 12 ? "abstain" : 12,
				};
			}
			return baseAction(t, e);
		},
	);
	const idiot = engine.player(12);
	assert.equal(idiot.alive, true);
	assert.equal(idiot.revealed, true);
	assert.equal(canVote(idiot), false);
	assert.equal(
		engine.allEvents.some((event) => event.type === "last_words" && event.actor === 12),
		false,
	);
	const reveal = engine.allEvents.find((event) => event.type === "idiot_revealed");
	assert.ok(reveal);
	assert.equal(reveal?.visibility.kind, "public");
	const record = engine.allEvents.find((event) => event.type === "vote_record");
	assert.equal(record?.data?.idiotRevealed, true);

	const win = make12("idiot-god", false);
	for (const player of win.state.players) {
		if (player.role === "seer" || player.role === "witch" || player.role === "hunter") {
			player.alive = false;
		}
	}
	assert.equal(win.computeWinner(), null);
	win.player(12).alive = false;
	assert.equal(win.computeWinner(), "wolf");
});

test("12 人局：猎人被放逐后开枪，被带走者留遗言", () => {
	const engine = make12("hunter-12", false);
	playUntil(
		engine,
		(t) => t.kind === "wolf_turn" && t.day === 2,
		(t, e) => {
			if (t.kind === "wolf_turn") {
				return { kind: "wolf_turn", seat: t.seat, speech: "", vote: "no_kill" };
			}
			if (t.kind === "day_vote") {
				return {
					kind: "day_vote",
					seat: t.seat,
					target: t.seat === 11 ? "abstain" : 11,
				};
			}
			if (t.kind === "hunter_shoot") {
				assert.equal(t.seat, 11);
				return { kind: "hunter_shoot", seat: t.seat, target: 4 };
			}
			return baseAction(t, e);
		},
	);
	assert.equal(engine.player(11).alive, false);
	assert.equal(engine.player(4).alive, false);
	assert.deepEqual(engine.player(4).death?.causes, ["hunter_shot"]);
	assert.equal(
		engine.allEvents.some((event) => event.type === "last_words" && event.actor === 4),
		true,
	);
});

test("12 人局：无人上警则无警长，流程继续", () => {
	const engine = make12("sheriff-none");
	playUntil(
		engine,
		(t, e) => t.kind === "day_speech" && e.state.day === 1,
		(t, e) => {
			if (t.kind === "wolf_turn") {
				return { kind: "wolf_turn", seat: t.seat, speech: "", vote: "no_kill" };
			}
			if (t.kind === "sheriff_signup") {
				return { kind: "sheriff_signup", seat: t.seat, run: false };
			}
			return baseAction(t, e);
		},
	);
	assert.equal(engine.state.sheriff, null);
	const result = engine.allEvents.find((event) => event.type === "sheriff_elected");
	assert.ok(result);
	assert.equal(result?.data?.seat, null);
	assert.equal(engine.state.phase, "day_discuss");
});

test("12 人局：唯一候选人自动当选", () => {
	const engine = make12("sheriff-lone");
	playUntil(
		engine,
		(t, e) => t.kind === "day_speech" && e.state.day === 1,
		(t, e) => {
			if (t.kind === "wolf_turn") {
				return { kind: "wolf_turn", seat: t.seat, speech: "", vote: "no_kill" };
			}
			if (t.kind === "sheriff_signup") {
				return { kind: "sheriff_signup", seat: t.seat, run: t.seat === 1 };
			}
			return baseAction(t, e);
		},
	);
	assert.equal(engine.state.sheriff, 1);
	const result = engine.allEvents.find((event) => event.type === "sheriff_elected");
	assert.equal(result?.data?.seat, 1);
	assert.equal(result?.data?.reason, "唯一上警候选人自动当选");
});

test("12 人局：警长竞选平票则无警长", () => {
	const engine = make12("sheriff-tie");
	playUntil(
		engine,
		(t, e) => t.kind === "day_speech" && e.state.day === 1,
		(t, e) => {
			if (t.kind === "wolf_turn") {
				return { kind: "wolf_turn", seat: t.seat, speech: "", vote: "no_kill" };
			}
			if (t.kind === "sheriff_signup") {
				return { kind: "sheriff_signup", seat: t.seat, run: t.seat <= 2 };
			}
			if (t.kind === "sheriff_vote") {
				return {
					kind: "sheriff_vote",
					seat: t.seat,
					target: t.seat % 2 === 0 ? 1 : 2,
				};
			}
			return baseAction(t, e);
		},
	);
	assert.equal(engine.state.sheriff, null);
	const result = engine.allEvents.find((event) => event.type === "sheriff_elected");
	assert.equal(result?.data?.seat, null);
});
