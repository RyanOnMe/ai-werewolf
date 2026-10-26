import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { GameEvent, GameMode as BoardMode, Role, Winner } from "../engine/types.ts";
import type { GameEngine } from "../engine/engine.ts";
import { runGame } from "../judge/runner.ts";
import { RandomPolicy } from "../agents/scripted.ts";
import { PiPlayer } from "../agents/pi-player.ts";
import {
	describeAvailableModels,
	loadPiModel,
	type LoadedModel,
} from "../agents/model.ts";

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
};

const SSE_HEADERS: Record<string, string> = {
	"Content-Type": "text/event-stream; charset=utf-8",
	"Cache-Control": "no-cache, no-transform",
	Connection: "keep-alive",
	"X-Accel-Buffering": "no",
};

/** 没有 summary 且长时间没有新事件，视为已中断的旧对局。 */
const STALE_RUN_MS = 15 * 60 * 1000;

type RunMode = "scripted" | "live";
type ViewMode = "public" | "god";
type GameState = "running" | "finished" | "error";

export interface SpectatorServerOptions {
	/** 对局目录，默认 runs/ */
	runsDir?: string;
	/** 静态前端目录，默认仓库 web/ */
	staticDir?: string;
	host?: string;
	port?: number;
	/** 是否允许 ?view=god（默认关闭） */
	godEnabled?: boolean;
	/** 前端“真实模型”表单的默认模型 */
	model?: string;
	/** 新对局默认板子，默认 9p */
	board?: BoardMode;
	thinkingLevel?: string;
	maxDays?: number;
	timeoutMs?: number;
	maxTokens?: number;
	/** 测试注入：跳过 pi 鉴权探测 */
	models?: string[];
	logger?: (message: string) => void;
}

export interface GameListItem {
	gameId: string;
	seed: string | null;
	playerCount: number | null;
	board: BoardMode | null;
	winner: Winner | null;
	days: number | null;
	eventCount: number;
	status: GameState;
	finished: boolean;
	error: string | null;
	mtime: number;
}

interface RunSummary {
	gameId?: string;
	seed?: string;
	mode?: BoardMode;
	playerCount?: number;
	winner?: Winner | null;
	endReason?: string | null;
	days?: number;
	phase?: string;
	eventCount?: number;
	aborted?: boolean;
	error?: string | null;
	metadata?: Record<string, unknown>;
}

class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "HttpError";
		this.status = status;
	}
}

function sanitize(value: string): string {
	const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return (cleaned || "game").slice(0, 60);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (existsSync(path)) return true;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
	}
	return existsSync(path);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 观战服务：
 * - 静态托管 web/
 * - GET  /api/config
 * - GET  /api/games
 * - POST /api/games                  { mode:"scripted"|"live", board:"9p"|"12p", seed, model, thinkingLevel, maxDays }
 * - GET  /api/games/:id/events?view=public|god   SSE
 * - GET  /api/health
 *
 * 事件只从 runs/<id>/events.ndjson 读取；不暴露 transcript 或 judge 之外的任何文件。
 */
export class SpectatorServer {
	private readonly server: Server;
	private readonly runsDir: string;
	private readonly staticDir: string;
	private readonly host: string;
	private readonly port: number;
	private readonly godEnabled: boolean;
	private readonly defaultModelSpec?: string;
	private readonly defaultBoard: BoardMode;
	private readonly thinkingLevel: string;
	private readonly maxDays: number;
	private readonly timeoutMs: number;
	private readonly maxTokens: number;
	private readonly modelsOverride?: string[];
	private readonly logger: (message: string) => void;
	private readonly clients = new Set<ServerResponse>();
	private readonly statuses = new Map<string, { state: GameState; message?: string }>();
	private active: { gameId: string; mode: RunMode; startedAt: number } | null = null;
	private starting = false;
	private modelsPromise: Promise<string[]> | null = null;
	private modelCache: LoadedModel | null = null;
	private modelCacheKey: string | null = null;

	constructor(options: SpectatorServerOptions = {}) {
		this.runsDir = resolve(options.runsDir ?? "runs");
		mkdirSync(this.runsDir, { recursive: true });
		this.staticDir = resolve(
			options.staticDir ?? fileURLToPath(new URL("../../web/", import.meta.url)),
		);
		this.host = options.host ?? "127.0.0.1";
		this.port = options.port ?? 7331;
		this.godEnabled = options.godEnabled ?? false;
		this.defaultModelSpec = options.model;
		this.defaultBoard = options.board === "12p" ? "12p" : "9p";
		this.thinkingLevel = options.thinkingLevel ?? "low";
		this.maxDays = options.maxDays ?? 30;
		this.timeoutMs = options.timeoutMs ?? 240_000;
		this.maxTokens = options.maxTokens ?? 2000;
		this.modelsOverride = options.models;
		this.logger = options.logger ?? ((message) => console.log(`[spectator] ${message}`));
		this.server = createServer((req, res) => {
			void this.handle(req, res);
		});
	}

	async start(): Promise<{ url: string; port: number }> {
		await new Promise<void>((resolvePromise, reject) => {
			const onError = (error: Error) => reject(error);
			this.server.once("error", onError);
			this.server.listen(this.port, this.host, () => {
				this.server.off("error", onError);
				resolvePromise();
			});
		});
		const address = this.server.address() as AddressInfo | null;
		const port = address?.port ?? this.port;
		const displayHost = this.host === "0.0.0.0" ? "127.0.0.1" : this.host;
		return { url: `http://${displayHost}:${port}`, port };
	}

	async close(): Promise<void> {
		for (const client of this.clients) {
			try {
				client.end();
			} catch {
				// ignore
			}
		}
		this.clients.clear();
		await new Promise<void>((resolvePromise, reject) => {
			this.server.close((error) => (error ? reject(error) : resolvePromise()));
		});
	}

	// -------------------------------------------------------------------
	// HTTP 分发
	// -------------------------------------------------------------------

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
			if (url.pathname.startsWith("/api/")) {
				await this.handleApi(req, res, url);
				return;
			}
			this.serveStatic(req, res, url.pathname);
		} catch (error) {
			const status = error instanceof HttpError ? error.status : 500;
			const message = messageOf(error);
			if (!res.headersSent) {
				this.sendJson(res, status, { error: message });
			} else {
				try {
					res.end();
				} catch {
					// ignore
				}
			}
		}
	}

	private async handleApi(
		req: IncomingMessage,
		res: ServerResponse,
		url: URL,
	): Promise<void> {
		const parts = url.pathname.split("/").filter(Boolean);
		const method = req.method ?? "GET";

		if (method === "GET" && url.pathname === "/api/health") {
			this.sendJson(res, 200, { ok: true });
			return;
		}

		if (method === "GET" && url.pathname === "/api/config") {
			const models = await this.getModels();
			this.sendJson(res, 200, {
				godEnabled: this.godEnabled,
				models,
				defaultModel: this.pickDefaultModel(models),
				boards: ["9p", "12p"],
				defaultBoard: this.defaultBoard,
				activeGameId: this.active?.gameId ?? null,
				starting: this.starting,
			});
			return;
		}

		if (url.pathname === "/api/games") {
			if (method === "GET") {
				this.sendJson(res, 200, { games: this.listGames() });
				return;
			}
			if (method === "POST") {
				const body = await this.readBody(req);
				const result = await this.startGame(body);
				this.sendJson(res, 200, result);
				return;
			}
			throw new HttpError(405, "method not allowed");
		}

		// /api/games/:id/events
		if (parts.length === 4 && parts[0] === "api" && parts[1] === "games" && parts[3] === "events") {
			if (method !== "GET") throw new HttpError(405, "method not allowed");
			const gameId = decodeURIComponent(parts[2]!);
			const view: ViewMode = url.searchParams.get("view") === "god" ? "god" : "public";
			if (view === "god" && !this.godEnabled) {
				throw new HttpError(403, "god view is disabled; start the server with --god");
			}
			this.streamEvents(req, res, gameId, view);
			return;
		}

		throw new HttpError(404, "not found");
	}

	// -------------------------------------------------------------------
	// API 实现
	// -------------------------------------------------------------------

	private async getModels(): Promise<string[]> {
		if (this.modelsOverride) return this.modelsOverride;
		if (!this.modelsPromise) {
			this.modelsPromise = describeAvailableModels().catch((error) => {
				this.logger(`模型列表读取失败：${messageOf(error)}`);
				return [];
			});
		}
		return this.modelsPromise;
	}

	private pickDefaultModel(models: string[]): string | null {
		if (this.defaultModelSpec && models.includes(this.defaultModelSpec)) {
			return this.defaultModelSpec;
		}
		for (const preferred of ["openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-terra"]) {
			if (models.includes(preferred)) return preferred;
		}
		return models[0] ?? null;
	}

	private async getLoadedModel(spec: string | undefined, thinking: string): Promise<LoadedModel> {
		const key = `${spec ?? ""}|${thinking}`;
		if (this.modelCache && this.modelCacheKey === key) return this.modelCache;
		const loaded = await loadPiModel({ model: spec, thinkingLevel: thinking });
		this.modelCache = loaded;
		this.modelCacheKey = key;
		return loaded;
	}

	private async startGame(body: Record<string, unknown>): Promise<{ gameId: string }> {
		if (this.active || this.starting) {
			throw new HttpError(409, `已有对局进行中：${this.active?.gameId ?? "正在启动"}`);
		}
		const rawMode = body.mode;
		if (rawMode !== "scripted" && rawMode !== "live") {
			throw new HttpError(400, "mode 必须是 scripted 或 live");
		}
		const mode: RunMode = rawMode;
		const rawBoard = body.board;
		if (rawBoard !== undefined && rawBoard !== "9p" && rawBoard !== "12p") {
			throw new HttpError(400, "board 必须是 9p 或 12p");
		}
		const board: BoardMode = rawBoard === "12p" ? "12p" : rawBoard === "9p" ? "9p" : this.defaultBoard;
		const seed =
			typeof body.seed === "string" && body.seed.trim().length > 0
				? body.seed.trim().slice(0, 80)
				: Date.now().toString(36);
		const requestedModel = typeof body.model === "string" ? body.model : undefined;
		const thinking =
			typeof body.thinkingLevel === "string" ? body.thinkingLevel : this.thinkingLevel;
		const maxDays =
			typeof body.maxDays === "number" && Number.isInteger(body.maxDays)
				? clamp(body.maxDays, 1, 100)
				: this.maxDays;

		this.starting = true;
		try {
			let loaded: LoadedModel | null = null;
			if (mode === "live") {
				const models = await this.getModels();
				if (models.length === 0) {
					throw new HttpError(
						400,
						"没有可用模型。请先运行 `pi auth` 登录，或在启动 serve 时用 --model 指定。",
					);
				}
				const spec = requestedModel ?? this.pickDefaultModel(models) ?? undefined;
				try {
					loaded = await this.getLoadedModel(spec, thinking);
				} catch (error) {
					throw new HttpError(400, `模型加载失败：${messageOf(error)}`);
				}
			}

			let gameId = `web-${board}-${sanitize(seed)}-${Date.now().toString(36)}`;
			let suffix = 1;
			while (existsSync(join(this.runsDir, gameId))) {
				gameId = `web-${board}-${sanitize(seed)}-${Date.now().toString(36)}-${suffix++}`;
			}
			const outDir = join(this.runsDir, gameId);
			this.active = { gameId, mode, startedAt: Date.now() };
			this.statuses.set(gameId, { state: "running" });

			const policyFactory = (seat: number, role: Role, engine: GameEngine) => {
				if (mode === "scripted") return new RandomPolicy(seat, seed);
				const modelInfo = loaded;
				if (!modelInfo) throw new Error("模型未初始化");
				return new PiPlayer({
					seat,
					role,
					mode: engine.state.mode,
					model: modelInfo.model,
					baseStreamFn: modelInfo.runtime.streamSimple.bind(modelInfo.runtime),
					sessionId: `${gameId}-seat-${seat}`,
					thinkingLevel: modelInfo.thinkingLevel,
					maxTokens: this.maxTokens,
					limits: {
						maxSpeechChars: engine.config.maxSpeechChars,
						maxLastWordsChars: engine.config.maxLastWordsChars,
					},
				});
			};

			void runGame({
				seed,
				gameId,
				mode: board,
				outDir,
				timeoutMs: this.timeoutMs,
				policyFactory,
				config: { maxDays },
				metadata: {
					mode,
					board,
					source: "web",
					model: loaded ? `${loaded.provider}/${loaded.modelId}` : null,
					thinkingLevel: loaded?.thinkingLevel ?? null,
				},
			})
				.then((result) => {
					this.statuses.set(gameId, { state: "finished" });
					if (this.active?.gameId === gameId) this.active = null;
					this.logger(`对局 ${gameId} 结束：${result.winner ?? "中止"}，${result.days} 天`);
				})
				.catch((error) => {
					const message = messageOf(error);
					this.statuses.set(gameId, { state: "error", message });
					if (this.active?.gameId === gameId) this.active = null;
					this.logger(`对局 ${gameId} 出错：${message}`);
				});

			this.logger(`启动对局 ${gameId}（${mode} / ${board}${loaded ? ` / ${loaded.provider}/${loaded.modelId}` : ""}）`);
			// 让前端拿到 gameId 后立刻连 SSE 时，events.ndjson 已经存在。
			await waitForFile(join(outDir, "events.ndjson"), 1000);
			return { gameId };
		} finally {
			this.starting = false;
		}
	}

	private listGames(): GameListItem[] {
		const items: GameListItem[] = [];
		for (const entry of readdirSync(this.runsDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const eventsPath = join(this.runsDir, entry.name, "events.ndjson");
			if (!existsSync(eventsPath)) continue;
			const summary = this.readSummary(entry.name);
			const stat = statSync(eventsPath);
			const memory = this.statuses.get(entry.name);
			let status: GameState =
				memory?.state ??
				(summary?.aborted ? "error" : summary?.phase === "ended" ? "finished" : "running");
			let error = summary?.aborted ? (summary.error ?? "游戏中止") : null;
			if (status === "running" && !summary && Date.now() - stat.mtimeMs > STALE_RUN_MS) {
				status = "error";
				error = "对局未完成（可能已中断）";
			}
			items.push({
				gameId: entry.name,
				seed: summary?.seed ?? null,
				playerCount: summary?.playerCount ?? null,
				board: summary?.mode ?? null,
				winner: summary?.winner ?? null,
				days: summary?.days ?? null,
				eventCount: summary?.eventCount ?? this.countLines(eventsPath),
				status,
				finished: summary?.phase === "ended",
				error,
				mtime: stat.mtimeMs,
			});
		}
		items.sort((a, b) => b.mtime - a.mtime);
		return items.slice(0, 50);
	}

	private readSummary(gameId: string): RunSummary | null {
		const path = join(this.runsDir, gameId, "summary.json");
		if (!existsSync(path)) return null;
		try {
			return JSON.parse(readFileSync(path, "utf8")) as RunSummary;
		} catch {
			return null;
		}
	}

	private countLines(path: string): number {
		try {
			return readFileSync(path, "utf8")
				.split("\n")
				.filter((line) => line.trim().length > 0).length;
		} catch {
			return 0;
		}
	}

	private gameDir(gameId: string): string {
		if (!/^[A-Za-z0-9._-]+$/.test(gameId) || gameId.startsWith(".")) {
			throw new HttpError(400, "invalid game id");
		}
		const dir = join(this.runsDir, gameId);
		if (!existsSync(dir) || !statSync(dir).isDirectory()) {
			throw new HttpError(404, "game not found");
		}
		if (!existsSync(join(dir, "events.ndjson"))) {
			throw new HttpError(404, "game has no events");
		}
		return dir;
	}

	// -------------------------------------------------------------------
	// SSE
	// -------------------------------------------------------------------

	private streamEvents(
		req: IncomingMessage,
		res: ServerResponse,
		gameId: string,
		view: ViewMode,
	): void {
		const dir = this.gameDir(gameId);
		const eventsPath = join(dir, "events.ndjson");
		let sentLines = 0;
		let closed = false;
		let done = false;
		let pollTimer: NodeJS.Timeout | null = null;
		let heartbeat: NodeJS.Timeout | null = null;

		const cleanup = (): void => {
			if (pollTimer) clearTimeout(pollTimer);
			if (heartbeat) clearInterval(heartbeat);
			pollTimer = null;
			heartbeat = null;
			this.clients.delete(res);
		};

		const send = (event: string, data: unknown): void => {
			if (closed || res.writableEnded) return;
			res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
		};

		const finish = (state: "finished" | "error", message?: string): void => {
			if (done) return;
			done = true;
			send("done", { gameId, state, message });
			cleanup();
			if (!res.writableEnded) res.end();
		};

		const fail = (message: string): void => {
			send("server_error", { gameId, message });
			finish("error", message);
		};

		const tick = (): void => {
			if (closed || done) return;
			try {
				if (existsSync(eventsPath)) {
					const raw = readFileSync(eventsPath, "utf8");
					const complete = raw.split("\n").slice(0, -1);
					for (let index = sentLines; index < complete.length; index++) {
						const line = complete[index]!;
						sentLines = index + 1;
						if (!line.trim()) continue;
						let event: GameEvent;
						try {
							event = JSON.parse(line) as GameEvent;
						} catch {
							continue;
						}
						if (view === "public" && event.visibility.kind !== "public") continue;
						send("game", event);
					}
				}
				const status = this.statuses.get(gameId);
				if (status?.state === "error") {
					fail(status.message ?? "游戏出错");
					return;
				}
				const summary = this.readSummary(gameId);
				if (summary?.aborted) {
					fail(summary.error ?? "游戏中止");
					return;
				}
				if (!status && !summary && !this.active) {
					const stat = statSync(eventsPath);
					if (Date.now() - stat.mtimeMs > STALE_RUN_MS) {
						fail("对局未完成（可能已中断）");
						return;
					}
				}
				if (
					status?.state === "finished" ||
					summary?.phase === "ended" ||
					this.lastLineIsGameEnd(eventsPath)
				) {
					finish("finished");
					return;
				}
			} catch (error) {
				fail(`读取事件失败：${messageOf(error)}`);
				return;
			}
			pollTimer = setTimeout(tick, 250);
		};

		res.on("close", () => {
			closed = true;
			cleanup();
		});
		res.writeHead(200, SSE_HEADERS);
		res.write(": connected\n\n");
		this.clients.add(res);
		heartbeat = setInterval(() => {
			if (!closed && !res.writableEnded) res.write(": ping\n\n");
		}, 15_000);
		tick();
	}

	private lastLineIsGameEnd(eventsPath: string): boolean {
		if (!existsSync(eventsPath)) return false;
		try {
			const raw = readFileSync(eventsPath, "utf8");
			const lines = raw.split("\n").filter((line) => line.trim().length > 0);
			const last = lines.at(-1);
			if (!last) return false;
			const event = JSON.parse(last) as GameEvent;
			return event.type === "game_end";
		} catch {
			return false;
		}
	}

	// -------------------------------------------------------------------
	// 静态文件 & 工具
	// -------------------------------------------------------------------

	private serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
		if (req.method !== "GET" && req.method !== "HEAD") {
			throw new HttpError(405, "method not allowed");
		}
		let decoded: string;
		try {
			decoded = decodeURIComponent(pathname);
		} catch {
			throw new HttpError(400, "bad path");
		}
		if (decoded === "/") decoded = "/index.html";
		const file = resolve(this.staticDir, `.${decoded}`);
		if (!file.startsWith(this.staticDir + sep)) {
			throw new HttpError(404, "not found");
		}
		if (!existsSync(file) || !statSync(file).isFile()) {
			throw new HttpError(404, "not found");
		}
		const body = readFileSync(file);
		res.writeHead(200, {
			"Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
			"Cache-Control": "no-store",
			"Content-Length": body.byteLength,
		});
		res.end(req.method === "HEAD" ? undefined : body);
	}

	private async readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of req) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += buffer.byteLength;
			if (size > 100_000) throw new HttpError(413, "request body too large");
			chunks.push(buffer);
		}
		const raw = Buffer.concat(chunks).toString("utf8");
		if (!raw.trim()) return {};
		try {
			const parsed = JSON.parse(raw);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error("body must be a JSON object");
			}
			return parsed as Record<string, unknown>;
		} catch (error) {
			throw new HttpError(400, `invalid JSON body: ${messageOf(error)}`);
		}
	}

	private sendJson(res: ServerResponse, status: number, value: unknown): void {
		const body = JSON.stringify(value);
		res.writeHead(status, {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
			"Content-Length": Buffer.byteLength(body),
		});
		res.end(body);
	}
}

export async function startSpectatorServer(
	options: SpectatorServerOptions = {},
): Promise<{ server: SpectatorServer; url: string; port: number }> {
	const instance = new SpectatorServer(options);
	const { url, port } = await instance.start();
	return { server: instance, url, port };
}
