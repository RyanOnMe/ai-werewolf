import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpectatorServer } from "../src/server/spectator-server.ts";

interface SseMessage {
	event: string;
	data: string;
}

async function readSse(url: string, timeoutMs = 15_000): Promise<SseMessage[]> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { signal: controller.signal });
		assert.equal(response.status, 200);
		assert.ok(response.body);
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		const messages: SseMessage[] = [];
		let buffer = "";
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let boundary = buffer.indexOf("\n\n");
			while (boundary >= 0) {
				const block = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				let event = "message";
				let data = "";
				for (const line of block.split("\n")) {
					if (line.startsWith("event:")) event = line.slice(6).trim();
					else if (line.startsWith("data:")) data += line.slice(5).trim();
				}
				if (data) messages.push({ event, data });
				boundary = buffer.indexOf("\n\n");
			}
			if (messages.some((message) => message.event === "done")) break;
		}
		await reader.cancel().catch(() => {});
		return messages;
	} finally {
		clearTimeout(timer);
	}
}

async function fetchJson(url: string, options?: RequestInit): Promise<any> {
	const response = await fetch(url, options);
	const text = await response.text();
	const data = text ? JSON.parse(text) : null;
	return { status: response.status, data };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFinished(base: string, gameId: string): Promise<any> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const { data } = await fetchJson(`${base}/api/games`);
		const game = data.games.find((item: any) => item.gameId === gameId);
		if (game && game.status === "finished") return game;
		await sleep(100);
	}
	throw new Error(`game ${gameId} did not finish`);
}

async function startScriptedGame(base: string, seed: string, board?: "9p" | "12p"): Promise<string> {
	const { status, data } = await fetchJson(`${base}/api/games`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ mode: "scripted", seed, ...(board ? { board } : {}) }),
	});
	assert.equal(status, 200);
	assert.equal(typeof data.gameId, "string");
	return data.gameId;
}

test("观战服务：静态页、配置、脚本对局、公开 SSE 与信息过滤", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "werewolf-server-"));
	const server = new SpectatorServer({
		runsDir,
		port: 0,
		host: "127.0.0.1",
		models: [],
		logger: () => {},
	});
	try {
		const { url } = await server.start();

		const page = await fetch(`${url}/`);
		assert.equal(page.status, 200);
		assert.ok((await page.text()).includes("AI 狼人杀"));

		const config = await fetchJson(`${url}/api/config`);
		assert.equal(config.status, 200);
		assert.equal(config.data.godEnabled, false);
		assert.deepEqual(config.data.models, []);
		assert.equal(config.data.defaultModel, null);
		assert.deepEqual(config.data.boards, ["9p", "12p"]);
		assert.equal(config.data.defaultBoard, "9p");

		const gameId = await startScriptedGame(url, "server-test");
		const finished = await waitForFinished(url, gameId);
		assert.notEqual(finished.winner, null);
		assert.equal(finished.eventCount > 40, true);

		const messages = await readSse(`${url}/api/games/${gameId}/events?view=public`);
		const events = messages
			.filter((message) => message.event === "game")
			.map((message) => JSON.parse(message.data));
		const done = messages.find((message) => message.event === "done");
		assert.ok(done);
		assert.equal(JSON.parse(done.data).state, "finished");
		assert.equal(events.length > 40, true);
		assert.equal(events[0].type, "game_start");
		assert.equal(events.at(-1).type, "game_end");
		assert.equal(
			events.every((event: any) => event.visibility.kind === "public"),
			true,
		);
		assert.equal(events.some((event: any) => event.type === "role_assigned"), false);
		assert.equal(events.some((event: any) => event.type === "game_end"), true);

		const god = await fetch(`${url}/api/games/${gameId}/events?view=god`);
		assert.equal(god.status, 403);
		await god.body?.cancel();

		const missing = await fetch(`${url}/api/games/nope/events?view=public`);
		assert.equal(missing.status, 404);
		await missing.body?.cancel();

		const traversal = await fetch(`${url}/api/games/..%2F..%2Fetc/events?view=public`);
		assert.equal([400, 404].includes(traversal.status), true);
		await traversal.body?.cancel();

		const invalidMode = await fetchJson(`${url}/api/games`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mode: "nope" }),
		});
		assert.equal(invalidMode.status, 400);

		const invalidBoard = await fetchJson(`${url}/api/games`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mode: "scripted", board: "nope" }),
		});
		assert.equal(invalidBoard.status, 400);
	} finally {
		await server.close().catch(() => {});
		rmSync(runsDir, { recursive: true, force: true });
	}
});

test("观战服务：--god 启用后 SSE 包含身份与狼队私密事件", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "werewolf-server-god-"));
	const server = new SpectatorServer({
		runsDir,
		port: 0,
		host: "127.0.0.1",
		godEnabled: true,
		models: [],
		logger: () => {},
	});
	try {
		const { url } = await server.start();
		const gameId = await startScriptedGame(url, "server-god-test");
		await waitForFinished(url, gameId);
		const messages = await readSse(`${url}/api/games/${gameId}/events?view=god`);
		const events = messages
			.filter((message) => message.event === "game")
			.map((message) => JSON.parse(message.data));
		assert.equal(events.length > 40, true);
		assert.equal(events.some((event: any) => event.type === "role_assigned"), true);
		assert.equal(
			events.some(
				(event: any) =>
					event.visibility.kind === "wolves" &&
					["wolf_speech", "wolf_vote", "wolf_target"].includes(event.type),
			),
			true,
		);
		assert.equal(
			events.some(
				(event: any) =>
					event.visibility.kind === "seat" && event.type === "seer_result",
			),
			true,
		);
		assert.equal(
			events.every((event: any) => typeof event.seq === "number"),
			true,
		);
	} finally {
		await server.close().catch(() => {});
		rmSync(runsDir, { recursive: true, force: true });
	}
});

test("观战服务：12 人局公开 SSE 包含上警与警长事件，不泄露身份", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "werewolf-server-12p-"));
	const server = new SpectatorServer({
		runsDir,
		port: 0,
		host: "127.0.0.1",
		models: [],
		logger: () => {},
	});
	try {
		const { url } = await server.start();
		const gameId = await startScriptedGame(url, "server-12p-test", "12p");
		await waitForFinished(url, gameId);

		const list = await fetchJson(`${url}/api/games`);
		const item = list.data.games.find((game: any) => game.gameId === gameId);
		assert.equal(item.playerCount, 12);
		assert.equal(item.board, "12p");

		const messages = await readSse(`${url}/api/games/${gameId}/events?view=public`);
		const events = messages
			.filter((message) => message.event === "game")
			.map((message) => JSON.parse(message.data));
		assert.equal(events[0].data?.playerCount, 12);
		assert.equal(events.some((event: any) => event.type === "sheriff_signup"), true);
		assert.equal(events.some((event: any) => event.type === "sheriff_speech"), true);
		assert.equal(events.some((event: any) => event.type === "sheriff_elected"), true);
		assert.equal(events.some((event: any) => event.type === "role_assigned"), false);
		assert.equal(
			events.every((event: any) => event.visibility.kind === "public"),
			true,
		);
	} finally {
		await server.close().catch(() => {});
		rmSync(runsDir, { recursive: true, force: true });
	}
});
