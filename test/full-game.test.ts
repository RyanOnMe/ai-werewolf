import test from "node:test";
import assert from "node:assert/strict";
import { GameEngine } from "../src/engine/engine.ts";
import { RandomPolicy } from "../src/agents/scripted.ts";
import { driveGame } from "../src/judge/driver.ts";
import type { PlayerPolicy } from "../src/engine/types.ts";

function policiesFor(seed: string, playerCount = 9): Map<number, PlayerPolicy> {
	const policies = new Map<number, PlayerPolicy>();
	for (let seat = 1; seat <= playerCount; seat++) {
		policies.set(seat, new RandomPolicy(seat, seed));
	}
	return policies;
}

test("随机策略全流程：30 个种子全部正常结束，事件序列可校验", async () => {
	for (let i = 0; i < 30; i++) {
		const seed = `full-game-${i}`;
		const engine = GameEngine.create({
			seed,
			gameId: `full-${i}`,
			clock: () => "2026-01-01T00:00:00.000Z",
		});
		await driveGame(engine, { policies: policiesFor(seed) });
		assert.equal(engine.state.phase, "ended", `seed ${seed} 没有结束`);
		assert.notEqual(engine.state.winner, null, `seed ${seed} 以平局结束`);
		assert.equal(engine.state.day <= engine.config.maxDays, true);

		const events = engine.allEvents;
		assert.equal(events.length > 40, true, `seed ${seed} 事件过少`);
		assert.equal(events[0]?.type, "game_start");
		assert.equal(events.at(-1)?.type, "game_end");
		assert.equal(events.filter((e) => e.type === "game_end").length, 1);
		assert.equal(events.filter((e) => e.type === "action_rejected").length, 0);

		for (let index = 0; index < events.length; index++) {
			assert.equal(events[index]?.seq, index + 1, `seed ${seed} 事件序号断裂`);
			if (index > 0) {
				assert.equal(events[index]!.seq, events[index - 1]!.seq + 1);
			}
		}

		const end = events.at(-1)!;
		const roles = end.data?.roles as Record<string, string>;
		assert.equal(Object.keys(roles).length, 9);
		for (const player of engine.state.players) {
			assert.equal(roles[String(player.seat)], player.role);
		}

		const turnStarts = events.filter((e) => e.type === "turn_start");
		assert.equal(turnStarts.length > 20, true);
		const publicLog = events.filter((e) => e.visibility.kind === "public");
		assert.equal(publicLog.some((e) => e.type === "game_end"), true);

		for (const lastWords of events.filter((e) => e.type === "last_words")) {
			const player = engine.state.players.find((p) => p.seat === lastWords.actor);
			assert.notEqual(player?.death?.phase, "dawn", `seed ${seed} 夜间死亡不应有遗言`);
		}
	}
});

test("12 人随机策略全流程：20 个种子全部正常结束，含警长竞选", async () => {
	for (let i = 0; i < 20; i++) {
		const seed = `full-12p-${i}`;
		const engine = GameEngine.create({
			seed,
			gameId: `full-12p-${i}`,
			mode: "12p",
			clock: () => "2026-01-01T00:00:00.000Z",
		});
		await driveGame(engine, { policies: policiesFor(seed, 12) });
		assert.equal(engine.state.phase, "ended", `seed ${seed} 没有结束`);
		assert.notEqual(engine.state.winner, null, `seed ${seed} 以平局结束`);

		const events = engine.allEvents;
		assert.equal(events[0]?.type, "game_start");
		assert.equal(events[0]?.data?.playerCount, 12);
		assert.equal(events.at(-1)?.type, "game_end");
		assert.equal(events.filter((e) => e.type === "sheriff_elected").length, 1);
		assert.equal(
			events.some(
				(e) => e.type === "sheriff_elected" && e.visibility.kind === "public",
			),
			true,
		);
		assert.equal(events.filter((e) => e.type === "action_rejected").length, 0);
		assert.equal(events.length > 60, true, `seed ${seed} 事件过少`);

		const end = events.at(-1)!;
		const roles = end.data?.roles as Record<string, string>;
		assert.equal(Object.keys(roles).length, 12);
		for (const player of engine.state.players) {
			assert.equal(roles[String(player.seat)], player.role);
		}
		for (const lastWords of events.filter((e) => e.type === "last_words")) {
			const player = engine.state.players.find((p) => p.seat === lastWords.actor);
			assert.notEqual(player?.death?.phase, "dawn", `seed ${seed} 夜间死亡不应有遗言`);
		}
	}
});
