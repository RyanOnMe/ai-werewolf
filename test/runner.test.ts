import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGame } from "../src/judge/runner.ts";
import { RandomPolicy } from "../src/agents/scripted.ts";
import type { Action, PlayerPolicy, PlayerView, Role, TurnRequest } from "../src/engine/types.ts";

class WithTranscript implements PlayerPolicy {
	readonly seat: number;
	private readonly inner: RandomPolicy;

	constructor(seat: number) {
		this.seat = seat;
		this.inner = new RandomPolicy(seat, "runner-test");
	}

	decide(turn: TurnRequest, view: PlayerView): Promise<Action> {
		return this.inner.decide(turn, view);
	}

	transcript(): unknown[] {
		return [
			{ role: "system", content: `seat ${this.seat}` },
			{ role: "user", content: "test transcript" },
		];
	}
}

test("runner 落的 events.ndjson 与 summary 一致，且包含开局事件", async () => {
	const dir = mkdtempSync(join(tmpdir(), "werewolf-runner-"));
	try {
		const result = await runGame({
			seed: "runner-test",
			gameId: "runner-test",
			outDir: dir,
			policyFactory: (seat: number, _role: Role): PlayerPolicy => new WithTranscript(seat),
		});
		const lines = readFileSync(join(dir, "events.ndjson"), "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0);
		const events = lines.map((line) => JSON.parse(line) as { seq: number; type: string });
		assert.equal(events.length, result.events.length);
		assert.equal(events[0]?.seq, 1);
		assert.equal(events[0]?.type, "game_start");
		assert.equal(events.at(-1)?.type, "game_end");
		for (let index = 0; index < events.length; index++) {
			assert.equal(events[index]?.seq, index + 1);
		}
		const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")) as {
			eventCount: number;
			winner: string | null;
			phase: string;
		};
		assert.equal(summary.eventCount, events.length);
		assert.equal(summary.phase, "ended");
		assert.notEqual(summary.winner, null);
		const transcripts = readdirSync(join(dir, "transcripts"));
		assert.equal(transcripts.length, 9);
		for (const file of transcripts) {
			const content = readFileSync(join(dir, "transcripts", file), "utf8").trim();
			assert.equal(content.length > 0, true);
			JSON.parse(content.split("\n")[0]!);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
