import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpectatorServer } from "../src/server/spectator-server.ts";
import { COMMANDCODE_SPECS, DUAL_PARATERA_SPECS } from "../src/agents/model-routing.ts";
import { FAKE_MODEL, fakeStream, streamedTool } from "./fake-llm.ts";

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
		assert.equal(events.some((event: any) => event.type === "wolf_plan"), false);

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
				(event: any) => event.type === "wolf_plan" && event.visibility.kind === "wolves",
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
		assert.equal(events.some((event: any) => event.type === "wolf_plan"), false);
		assert.equal(
			events.every((event: any) => event.visibility.kind === "public"),
			true,
		);
	} finally {
		await server.close().catch(() => {});
		rmSync(runsDir, { recursive: true, force: true });
	}
});

test("观战服务：双模型座位、发言草稿、重试和私密狼队草稿分流", async () => {
	const runsDir = mkdtempSync(join(tmpdir(), "werewolf-server-live-"));
	let publicCalls = 0;
	const fallback = fakeStream((context) => {
		const name = context.tools?.find((tool) => !tool.name.startsWith("view_") && tool.name !== "wolf_speak")?.name ?? "";
		const args = {
			wolf_vote: { target: "no_kill" },
			seer_check: { target: String(context.systemPrompt).includes("座位：1号") ? 2 : 1 },
			witch_act: { save: false, poisonTarget: null },
			sheriff_run: { run: false },
			vote: { target: "abstain" },
			say: { text: "我听完再投票。" },
		}[name] ?? {};
		return { name, args };
	});
	const server = new SpectatorServer({
		runsDir, port: 0, godEnabled: true, logger: () => {},
		models: [...DUAL_PARATERA_SPECS, ...COMMANDCODE_SPECS],
		loadModels: async (specs) => specs.map((spec) => {
			const slash = spec.indexOf("/");
			const provider = spec.slice(0, slash);
			const modelId = spec.slice(slash + 1);
			return { provider, modelId, model: { ...FAKE_MODEL, provider, id: modelId }, thinkingLevel: "low",
				stream: (model, context, options) => {
					if (context.tools?.some((tool) => tool.name === "set_wolf_plan")) {
						return streamedTool("set_wolf_plan", "plan", ["PRIVATE_DRAFT_ONLY", "确认狼队战术"], { intervalMs: 245 });
					}
					if (context.tools?.some((tool) => tool.name === "say")) {
						switch (++publicCalls) {
							case 1: return streamedTool("say", "text", ["首个发言草稿"], {
								error: "502 MOCK_ERROR_SECRET", privateText: "RAW_ASSISTANT_ONLY", intervalMs: 240,
							});
							case 2: return streamedTool("say", "text", ["发言上半句，", "这是下半句。"], { intervalMs: 245 });
						}
					}
					return fallback(model, context, options);
				},
			};
		}),
	});
	try {
		const { url } = await server.start();
		const config = await fetchJson(`${url}/api/config`);
		assert.equal(config.data.defaultModel, COMMANDCODE_SPECS[0]);
		assert.deepEqual(config.data.modelSets[0].specs, COMMANDCODE_SPECS);
		const { status, data } = await fetchJson(`${url}/api/games`, {
			method: "POST",
			body: JSON.stringify({ mode: "live", model: COMMANDCODE_SPECS.join(","), board: "12p", seed: "server-model-stream", maxDays: 1 }),
		});
		assert.equal(status, 200);
		const streamUrl = `${url}/api/games/${data.gameId}/events`;
		const [pub, god] = await Promise.all([readSse(`${streamUrl}?view=public`), readSse(`${streamUrl}?view=god`)]);
		const roster = JSON.parse(pub.find((message) => message.event === "roster")!.data);
		assert.equal(roster.players.length, 12);
		assert.equal(roster.players[0].model.spec, COMMANDCODE_SPECS[0]);
		assert.equal(roster.players[11].model.spec, COMMANDCODE_SPECS[1]);
		assert.equal(roster.players[0].model.logo, "/models/deepseek.svg");
		assert.equal(roster.players[11].model.logo, "/models/minimax.svg");
		assert.match((await fetch(`${url}${roster.players[1].model.logo}`)).headers.get("content-type") ?? "", /^image\/svg/);
		const raw = JSON.stringify(pub);
		assert.doesNotMatch(raw, /PRIVATE_DRAFT_ONLY|RAW_ASSISTANT_ONLY|MOCK_ERROR_SECRET/);
		const turns = pub.filter((message) => message.event === "turn").map((message) => JSON.parse(message.data).turn).filter(Boolean);
		assert.ok(turns.length > 0 && turns.every((turn) => turn.visibility === "public"));
		assert.ok(turns.some((turn) => turn.progress.state === "retrying"));
		const draft = pub.findIndex((message) => message.event === "turn" && JSON.parse(message.data).turn?.progress?.text === "发言上半句，");
		const settled = pub.findIndex((message) => message.event === "game" && JSON.parse(message.data).text === "发言上半句，这是下半句。");
		assert.ok(draft >= 0 && settled > draft, "确认发言前收到流式片段");
		assert.ok(god.some((message) => message.event === "turn" && message.data.includes("PRIVATE_DRAFT_ONLY")));
		assert.ok(god.some((message) => message.event === "game" && JSON.parse(message.data).type === "model_retry"));
		assert.doesNotMatch(readFileSync(join(runsDir, data.gameId, "events.ndjson"), "utf8"), /首个发言草稿|RAW_ASSISTANT_ONLY/);

		const replay = await readSse(streamUrl);
		assert.ok(!replay.some((message) => message.event === "turn"), "回放没有草稿");
		assert.deepEqual(JSON.parse(replay.find((message) => message.event === "roster")!.data), roster);
	} finally {
		await server.close();
		rmSync(runsDir, { recursive: true, force: true });
	}
});
