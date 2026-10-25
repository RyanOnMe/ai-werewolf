import {
	DEFAULT_CONFIG,
	type Action,
	type DeathCause,
	type EventType,
	type GameEvent,
	type GameState,
	type PlayerState,
	type PlayerView,
	type RulesConfig,
	type TurnKind,
	type TurnRequest,
	type Visibility,
	type Winner,
	type Role,
	ROLE_LABEL,
	factionOf,
	isGod,
	RuleError,
	seatLabel,
} from "./types.ts";
import { createRng, nextSeatWhere, type Rng } from "./rng.ts";

const ROLE_SETUP_9 = [
	"werewolf",
	"werewolf",
	"werewolf",
	"villager",
	"villager",
	"villager",
	"seer",
	"witch",
	"hunter",
] as const;

type AutoKind =
	| "start_night"
	| "resolve_wolves"
	| "resolve_night"
	| "start_day"
	| "start_vote"
	| "resolve_vote";

type AutoTask =
	| { t: "auto"; kind: AutoKind }
	| { t: "auto"; kind: "post_deaths"; next: "day" | "night" }
	| { t: "auto"; kind: "end_game" };

type TurnTask = { t: "turn"; kind: TurnKind; seat: number };
type Task = AutoTask | TurnTask;

export interface EngineOptions {
	seed: string;
	gameId?: string;
	config?: Partial<RulesConfig>;
	/** 测试/自定义局用：直接指定每个座位的身份，跳过洗牌。 */
	roles?: Role[];
	clock?: () => string;
}

export class GameEngine {
	readonly state: GameState;
	readonly config: RulesConfig;
	readonly rng: Rng;
	private readonly events: GameEvent[] = [];
	private readonly queue: Task[] = [];
	private readonly clock: () => string;
	private pendingTurn: TurnRequest | null = null;
	private turnCounter = 0;

	private constructor(
		state: GameState,
		config: RulesConfig,
		rng: Rng,
		clock: () => string,
	) {
		this.state = state;
		this.config = config;
		this.rng = rng;
		this.clock = clock;
	}

	static create(options: EngineOptions): GameEngine {
		const config: RulesConfig = { ...DEFAULT_CONFIG, ...options.config };
		if (config.playerCount !== 9) {
			throw new RuleError("unsupported_player_count", "v1 只支持 9 人局（3狼、3民、预言家、女巫、猎人）");
		}
		const seed = options.seed;
		const gameId = options.gameId ?? `game-${Date.now().toString(36)}`;
		const rng = createRng(seed);
		const roles = options.roles ? [...options.roles] : rng.shuffle(ROLE_SETUP_9);
		if (roles.length !== config.playerCount) {
			throw new RuleError("bad_role_setup", `角色数量 ${roles.length} 与玩家数 ${config.playerCount} 不一致`);
		}
		const count = (role: Role) => roles.filter((r) => r === role).length;
		if (count("werewolf") !== 3 || count("villager") !== 3 || count("seer") !== 1 || count("witch") !== 1 || count("hunter") !== 1) {
			throw new RuleError("bad_role_setup", "v1 需要恰好 3狼、3村民、1预言家、1女巫、1猎人");
		}
		const players: PlayerState[] = roles.map((role, index) => ({
			seat: index + 1,
			role,
			alive: true,
			death: null,
		}));
		const state: GameState = {
			gameId,
			seed,
			day: 1,
			phase: "setup",
			players,
			witch: { antidote: true, poison: true },
			night: {
				wolfVotes: {},
				wolfTarget: null,
				seerTarget: null,
				seerResult: null,
				witchSave: false,
				witchPoison: null,
			},
			seerChecks: [],
			dayStartSeat: null,
			votes: {},
			winner: null,
			endReason: null,
		};
		const engine = new GameEngine(state, config, rng, options.clock ?? (() => new Date().toISOString()));

		engine.emit("game_start", { kind: "public" }, {
			text: "9人局开始：3狼人、3村民、预言家、女巫、猎人。狼人杀光所有村民或所有神职即获胜；好人放逐所有狼人即获胜。",
			data: { playerCount: 9, roleSetup: ROLE_SETUP_9 },
		});
		for (const player of players) {
			engine.emit("role_assigned", { kind: "judge" }, {
				actor: player.seat,
				text: `${seatLabel(player.seat)} 的身份是 ${ROLE_LABEL[player.role]}`,
				data: { seat: player.seat, role: player.role },
			});
		}
		engine.queue.push({ t: "auto", kind: "start_night" });
		return engine;
	}

	get allEvents(): readonly GameEvent[] {
		return this.events;
	}

	/** 由 runner 写入法官侧事件（agent 错误、默认动作等）。 */
	recordJudge(type: EventType, text: string, data?: Record<string, unknown>): GameEvent {
		return this.emit(type, { kind: "judge" }, { text, data });
	}

	/**
	 * 推进到下一个需要玩家行动的时刻；期间自动处理播报、结算和胜负判定。
	 * 返回本次推进产生的事件，以及需要哪个玩家做什么。
	 */
	advance(): { events: GameEvent[]; turn: TurnRequest | null } {
		if (this.pendingTurn) {
			throw new Error("advance() called while a turn is pending; submit() must run first");
		}
		const start = this.events.length;
		while (true) {
			const task = this.queue[0];
			if (!task) {
				return { events: this.events.slice(start), turn: null };
			}
			if (task.t === "turn") {
				this.queue.shift();
				const turn = this.buildTurn(task);
				if (!turn) continue;
				this.pendingTurn = turn;
				this.turnCounter += 1;
				this.emit("turn_start", { kind: "judge" }, {
					actor: turn.seat,
					text: `turn ${turn.id}: ${turn.kind} / ${seatLabel(turn.seat)}`,
					data: { turnId: turn.id, kind: turn.kind, seat: turn.seat },
				});
				return { events: this.events.slice(start), turn };
			}
			this.queue.shift();
			this.runAuto(task);
		}
	}

	/** 提交当前待处理行动。校验失败抛 RuleError，状态不变。 */
	submit(action: Action): GameEvent[] {
		const turn = this.pendingTurn;
		if (!turn) {
			throw new RuleError("no_pending_turn", "当前没有待处理的行动");
		}
		if (action.seat !== turn.seat) {
			throw new RuleError(
				"wrong_seat",
				`行动座位 ${action.seat} 与待处理座位 ${turn.seat} 不一致`,
			);
		}
		if (action.kind !== turn.kind) {
			throw new RuleError(
				"wrong_action_kind",
				`行动类型 ${action.kind} 与待处理类型 ${turn.kind} 不一致`,
			);
		}
		const start = this.events.length;
		this.applyAction(turn, action);
		this.pendingTurn = null;
		return this.events.slice(start);
	}

	visibleEventsFor(seat: number): GameEvent[] {
		const player = this.player(seat);
		return this.events.filter((event) => isVisibleTo(event, player));
	}

	player(seat: number): PlayerState {
		const player = this.state.players[seat - 1];
		if (!player) throw new RuleError("bad_seat", `没有 ${seat} 号玩家`);
		return player;
	}

	aliveSeats(): number[] {
		return this.state.players.filter((p) => p.alive).map((p) => p.seat);
	}

	alivePlayers(): PlayerState[] {
		return this.state.players.filter((p) => p.alive);
	}

	computeWinner(): Winner | null {
		const alive = this.alivePlayers();
		const wolves = alive.filter((p) => p.role === "werewolf").length;
		if (wolves === 0) return "good";
		const villagers = alive.filter((p) => p.role === "villager").length;
		const gods = alive.filter((p) => isGod(p.role)).length;
		if (villagers === 0 || gods === 0) return "wolf";
		return null;
	}

	// ---------------------------------------------------------------------
	// 自动流程
	// ---------------------------------------------------------------------

	private runAuto(task: AutoTask): void {
		switch (task.kind) {
			case "start_night":
				this.startNight();
				return;
			case "resolve_wolves":
				this.resolveWolves();
				return;
			case "resolve_night":
				this.resolveNight();
				return;
			case "start_day":
				this.startDay();
				return;
			case "start_vote":
				this.startVote();
				return;
			case "resolve_vote":
				this.resolveVote();
				return;
			case "post_deaths":
				this.postDeaths(task.next);
				return;
			case "end_game":
				this.endGame(this.state.winner, this.state.endReason ?? "游戏结束");
				return;
		}
	}

	private startNight(): void {
		const winner = this.computeWinner();
		if (winner) {
			this.state.winner = winner;
			this.state.endReason = "胜负已分";
			this.queue.push({ t: "auto", kind: "end_game" });
			return;
		}
		if (this.state.day > this.config.maxDays) {
			this.state.winner = null;
			this.state.endReason = `超过最大天数 ${this.config.maxDays}`;
			this.queue.push({ t: "auto", kind: "end_game" });
			return;
		}
		this.state.phase = "night_wolves";
		this.state.night = {
			wolfVotes: {},
			wolfTarget: null,
			seerTarget: null,
			seerResult: null,
			witchSave: false,
			witchPoison: null,
		};
		this.state.votes = {};
		this.emit("phase", { kind: "public" }, {
			text: `天黑请闭眼。第 ${this.state.day} 夜开始。`,
			data: { night: this.state.day },
		});
		const wolves = this.aliveSeats().filter((seat) => this.player(seat).role === "werewolf");
		for (const seat of wolves) {
			this.queue.push({ t: "turn", kind: "wolf_turn", seat });
		}
		this.queue.push({ t: "auto", kind: "resolve_wolves" });
	}

	private resolveWolves(): void {
		const votes = this.state.night.wolfVotes;
		const counts = new Map<number, number>();
		for (const vote of Object.values(votes)) {
			if (typeof vote === "number") {
				counts.set(vote, (counts.get(vote) ?? 0) + 1);
			}
		}
		let max = 0;
		for (const count of counts.values()) max = Math.max(max, count);
		const top = [...counts.entries()].filter(([, count]) => count === max).map(([seat]) => seat);
		const target = top.length === 1 && max > 0 ? top[0]! : null;
		this.state.night.wolfTarget = target;
		this.emit("wolf_target", { kind: "wolves" }, {
			target,
			text: target === null ? "狼队决定空刀。" : `狼队决定刀杀 ${seatLabel(target)}。`,
			data: { votes: { ...votes }, target },
		});

		const alive = this.alivePlayers();
		const seer = alive.find((p) => p.role === "seer");
		const witch = alive.find((p) => p.role === "witch");
		if (seer) {
			this.queue.push({ t: "turn", kind: "seer_check", seat: seer.seat });
		}
		if (witch) {
			this.queue.push({ t: "turn", kind: "witch_act", seat: witch.seat });
		}
		this.queue.push({ t: "auto", kind: "resolve_night" });
	}

	private resolveNight(): void {
		this.state.phase = "dawn";
		const causes = new Map<number, DeathCause[]>();
		const addCause = (seat: number, cause: DeathCause) => {
			const list = causes.get(seat) ?? [];
			if (!list.includes(cause)) list.push(cause);
			causes.set(seat, list);
		};
		const wolfTarget = this.state.night.wolfTarget;
		if (wolfTarget !== null && !this.state.night.witchSave) {
			addCause(wolfTarget, "wolf_kill");
		}
		if (this.state.night.witchPoison !== null) {
			addCause(this.state.night.witchPoison, "poison");
		}

		const deadSeats = [...causes.keys()].sort((a, b) => a - b);
		if (deadSeats.length === 0) {
			this.emit("death", { kind: "public" }, {
				text: "天亮了。昨晚是平安夜，无人死亡。",
				data: { seats: [], causes: {} },
			});
			this.queue.push({ t: "auto", kind: "post_deaths", next: "day" });
			return;
		}

		for (const seat of deadSeats) {
			const player = this.player(seat);
			player.alive = false;
			player.death = { day: this.state.day, phase: "dawn", causes: causes.get(seat)! };
		}
		const labels = deadSeats.map(seatLabel).join("、");
		this.emit("death", { kind: "public" }, {
			text: `天亮了。昨晚 ${labels} 死亡。`,
			data: { seats: deadSeats },
		});
		this.emit("death", { kind: "judge" }, {
			text: `夜晚死亡明细：${deadSeats.map((seat) => `${seat}号(${causes.get(seat)!.join("+")})`).join("，")}`,
			data: { deaths: deadSeats.map((seat) => ({ seat, causes: causes.get(seat)! })) },
		});

		const winner = this.computeWinner();
		if (winner) {
			this.state.winner = winner;
			this.state.endReason = "夜晚死亡后胜负已分";
			for (const seat of deadSeats) this.queue.push({ t: "turn", kind: "last_words", seat });
			this.queue.push({ t: "auto", kind: "end_game" });
			return;
		}

		for (const seat of deadSeats) this.queue.push({ t: "turn", kind: "last_words", seat });
		const hunter = this.eligibleHunter(deadSeats);
		if (hunter !== null) {
			this.queue.push({ t: "turn", kind: "hunter_shoot", seat: hunter });
		}
		this.queue.push({ t: "auto", kind: "post_deaths", next: "day" });
	}

	private startDay(): void {
		this.state.phase = "day_discuss";
		const alive = this.aliveSeats();
		if (alive.length === 0) {
			this.state.winner = "wolf";
			this.state.endReason = "无人存活";
			this.queue.push({ t: "auto", kind: "end_game" });
			return;
		}
		if (this.state.dayStartSeat === null) {
			this.state.dayStartSeat = this.rng.pick(alive);
		} else {
			const previous = this.state.dayStartSeat;
			this.state.dayStartSeat =
				nextSeatWhere(previous, this.config.playerCount, (seat) => this.player(seat).alive) ?? alive[0]!;
		}
		const order = this.speakingOrder();
		this.emit("phase", { kind: "public" }, {
			text: `第 ${this.state.day} 天白天开始。存活：${alive.map(seatLabel).join("、")}。发言从 ${seatLabel(order[0] ?? this.state.dayStartSeat)} 开始。`,
			data: { alive, startSeat: this.state.dayStartSeat, order },
		});
		for (const seat of order) {
			this.queue.push({ t: "turn", kind: "day_speech", seat });
		}
		this.queue.push({ t: "auto", kind: "start_vote" });
	}

	private startVote(): void {
		this.state.phase = "day_vote";
		this.state.votes = {};
		const order = this.speakingOrder();
		this.emit("phase", { kind: "public" }, {
			text: "发言结束，现在开始放逐投票。",
			data: { order },
		});
		for (const seat of order) {
			this.queue.push({ t: "turn", kind: "day_vote", seat });
		}
		this.queue.push({ t: "auto", kind: "resolve_vote" });
	}

	private resolveVote(): void {
		const votes = this.state.votes;
		const counts = new Map<number, number>();
		for (const vote of Object.values(votes)) {
			if (typeof vote === "number") {
				counts.set(vote, (counts.get(vote) ?? 0) + 1);
			}
		}
		let max = 0;
		for (const count of counts.values()) max = Math.max(max, count);
		const top = [...counts.entries()].filter(([, count]) => count === max).map(([seat]) => seat);
		const exiled = top.length === 1 && max > 0 ? top[0]! : null;
		const voteText = this.formatVoteRecord(votes, counts, exiled);
		this.emit("vote_record", { kind: "public" }, {
			text: voteText,
			target: exiled,
			data: {
				votes: { ...votes },
				tally: Object.fromEntries(counts),
				exiled,
			},
		});

		if (exiled === null) {
			this.queue.push({ t: "auto", kind: "post_deaths", next: "night" });
			return;
		}

		const player = this.player(exiled);
		player.alive = false;
		player.death = { day: this.state.day, phase: "day_vote", causes: ["exile"] };
		this.emit("death", { kind: "judge" }, {
			actor: exiled,
			text: `${seatLabel(exiled)} 被放逐出局`,
			data: { seat: exiled, causes: ["exile"] },
		});

		const winner = this.computeWinner();
		if (winner) {
			this.state.winner = winner;
			this.state.endReason = "放逐后胜负已分";
			this.queue.push({ t: "turn", kind: "last_words", seat: exiled });
			this.queue.push({ t: "auto", kind: "end_game" });
			return;
		}

		this.queue.push({ t: "turn", kind: "last_words", seat: exiled });
		const hunter = this.eligibleHunter([exiled]);
		if (hunter !== null) {
			this.queue.push({ t: "turn", kind: "hunter_shoot", seat: hunter });
		}
		this.queue.push({ t: "auto", kind: "post_deaths", next: "night" });
	}

	private postDeaths(next: "day" | "night"): void {
		const winner = this.computeWinner();
		if (winner) {
			this.state.winner = winner;
			this.state.endReason = "死亡结算后胜负已分";
			this.queue.push({ t: "auto", kind: "end_game" });
			return;
		}
		if (next === "day") {
			this.queue.push({ t: "auto", kind: "start_day" });
			return;
		}
		this.state.day += 1;
		if (this.state.day > this.config.maxDays) {
			this.state.winner = null;
			this.state.endReason = `超过最大天数 ${this.config.maxDays}`;
			this.queue.push({ t: "auto", kind: "end_game" });
			return;
		}
		this.queue.push({ t: "auto", kind: "start_night" });
	}

	private endGame(winner: Winner | null, reason: string): void {
		if (this.state.phase === "ended") return;
		this.state.phase = "ended";
		this.state.winner = winner;
		this.state.endReason = reason;
		this.queue.length = 0;
		const roles = this.state.players
			.map((p) => `${seatLabel(p.seat)}${ROLE_LABEL[p.role]}`)
			.join("、");
		const winnerText =
			winner === "good" ? "好人阵营获胜" : winner === "wolf" ? "狼人阵营获胜" : "游戏中止";
		this.emit("game_end", { kind: "public" }, {
			text: `游戏结束：${winnerText}。身份公布：${roles}。`,
			data: {
				winner,
				reason,
				days: this.state.day,
				roles: Object.fromEntries(this.state.players.map((p) => [p.seat, p.role])),
				deaths: Object.fromEntries(
					this.state.players
						.filter((p) => p.death)
						.map((p) => [p.seat, p.death]),
				),
			},
		});
	}

	// ---------------------------------------------------------------------
	// 玩家行动
	// ---------------------------------------------------------------------

	private buildTurn(task: TurnTask): TurnRequest | null {
		const player = this.player(task.seat);
		const turnId = `T${this.turnCounter + 1}`;
		if (task.kind !== "last_words" && task.kind !== "hunter_shoot" && !player.alive) {
			this.emit("action_rejected", { kind: "judge" }, {
				actor: task.seat,
				text: `跳过已出局玩家的 ${task.kind}`,
				data: { seat: task.seat, kind: task.kind },
			});
			return null;
		}

		switch (task.kind) {
			case "wolf_turn": {
				if (player.role !== "werewolf" || !player.alive) return null;
				this.state.phase = "night_wolves";
				const targets = this.aliveSeats().filter(
					(seat) => this.config.allowWolfSelfKill || this.player(seat).role !== "werewolf",
				);
				return {
					id: turnId,
					kind: "wolf_turn",
					seat: task.seat,
					day: this.state.day,
					phase: this.state.phase,
					legalTargets: targets,
					promptHint:
						"现在是你作为狼人的夜间行动。你可以先调用 wolf_speak 在狼队频道发言（可选，可多次）；然后必须调用 wolf_vote 选择一个存活玩家，或选择 no_kill 空刀。",
					wolfTeammates: this.state.players
						.filter((p) => p.role === "werewolf" && p.seat !== task.seat)
						.map((p) => p.seat),
				};
			}
			case "seer_check": {
				if (player.role !== "seer" || !player.alive) return null;
				this.state.phase = "night_seer";
				return {
					id: turnId,
					kind: "seer_check",
					seat: task.seat,
					day: this.state.day,
					phase: this.state.phase,
					legalTargets: this.aliveSeats().filter((seat) => seat !== task.seat),
					promptHint:
						"请调用 seer_check 查验一名存活玩家（不能查验自己）。你会得到“狼人”或“好人”的结果。",
				};
			}
			case "witch_act": {
				if (player.role !== "witch" || !player.alive) return null;
				this.state.phase = "night_witch";
				const witch = player;
				const victim = this.state.night.wolfTarget;
				const selfSaveBlocked =
					victim === witch.seat && this.config.selfSaveNight1Only && this.state.day > 1;
				const canSave =
					this.state.witch.antidote && victim !== null && !selfSaveBlocked;
				const canPoison = this.state.witch.poison;
				return {
					id: turnId,
					kind: "witch_act",
					seat: task.seat,
					day: this.state.day,
					phase: this.state.phase,
					legalTargets: this.aliveSeats().filter((seat) => seat !== task.seat),
					promptHint:
						"请调用 witch_act 决定今晚是否用药。解药最多一次，毒药最多一次，且不能同一晚同时使用。你也可以选择什么都不用。",
					canSave,
					canPoison,
					canSelfSave: !selfSaveBlocked,
					witchVictim: victim,
				};
			}
			case "last_words": {
				if (player.alive) return null;
				this.state.phase = "last_words";
				return {
					id: turnId,
					kind: "last_words",
					seat: task.seat,
					day: this.state.day,
					phase: this.state.phase,
					legalTargets: [],
					promptHint: "你已出局。请调用 last_words 留下你的遗言。",
				};
			}
			case "hunter_shoot": {
				if (player.alive || player.role !== "hunter") return null;
				const causes = player.death?.causes ?? [];
				if (causes.includes("poison")) return null;
				this.state.phase = "hunter_shot";
				return {
					id: turnId,
					kind: "hunter_shoot",
					seat: task.seat,
					day: this.state.day,
					phase: this.state.phase,
					legalTargets: this.aliveSeats(),
					promptHint:
						"你是猎人。现在可以开枪带走一名存活玩家。请调用 hunter_shoot 指定目标；如果放弃，传入 target: null。",
				};
			}
			case "day_speech": {
				if (!player.alive) return null;
				this.state.phase = "day_discuss";
				return {
					id: turnId,
					kind: "day_speech",
					seat: task.seat,
					day: this.state.day,
					phase: this.state.phase,
					legalTargets: [],
					promptHint: "轮到你发言。请调用 say 提交你的公开发言。",
				};
			}
			case "day_vote": {
				if (!player.alive) return null;
				this.state.phase = "day_vote";
				return {
					id: turnId,
					kind: "day_vote",
					seat: task.seat,
					day: this.state.day,
					phase: this.state.phase,
					legalTargets: this.aliveSeats().filter(
						(seat) => this.config.allowSelfVote || seat !== task.seat,
					),
					promptHint: `请调用 vote 选择一名要放逐的存活玩家（不能投自己），或选择 abstain 弃票。`,
				};
			}
		}
	}

	private applyAction(turn: TurnRequest, action: Action): void {
		const player = this.player(action.seat);
		switch (action.kind) {
			case "wolf_turn": {
				if (!player.alive || player.role !== "werewolf") {
					throw new RuleError("not_wolf", "只有存活的狼人可以行动");
				}
				if (action.speech.length > this.config.maxSpeechChars) {
					throw new RuleError("speech_too_long", `狼队发言不能超过 ${this.config.maxSpeechChars} 字`);
				}
				if (action.vote !== "no_kill") {
					const target = this.player(action.vote);
					if (!target.alive) throw new RuleError("target_dead", "不能刀杀已出局玩家");
					if (!this.config.allowWolfSelfKill && target.role === "werewolf") {
						throw new RuleError("wolf_self_kill_forbidden", "当前规则不允许自刀");
					}
				}
				this.state.phase = "night_wolves";
				if (action.speech.trim().length > 0) {
					this.emit("wolf_speech", { kind: "wolves" }, {
						actor: action.seat,
						text: action.speech,
					});
				}
				this.state.night.wolfVotes[action.seat] = action.vote;
				this.emit("wolf_vote", { kind: "wolves" }, {
					actor: action.seat,
					target: typeof action.vote === "number" ? action.vote : null,
					text:
						action.vote === "no_kill"
							? `${seatLabel(action.seat)} 选择空刀`
							: `${seatLabel(action.seat)} 投票刀杀 ${seatLabel(action.vote)}`,
					data: { vote: action.vote },
				});
				return;
			}
			case "seer_check": {
				if (!player.alive || player.role !== "seer") {
					throw new RuleError("not_seer", "只有存活的预言家可以查验");
				}
				if (action.target === action.seat) throw new RuleError("self_check", "不能查验自己");
				const target = this.player(action.target);
				if (!target.alive) throw new RuleError("target_dead", "不能查验已出局玩家");
				const result = factionOf(target.role);
				this.state.phase = "night_seer";
				this.state.night.seerTarget = action.target;
				this.state.night.seerResult = result;
				this.state.seerChecks.push({ day: this.state.day, target: action.target, result });
				this.emit("seer_result", { kind: "seat", seat: action.seat }, {
					actor: action.seat,
					target: action.target,
					text: `你查验了 ${seatLabel(action.target)}，结果是：${result === "wolf" ? "狼人" : "好人"}。`,
					data: { target: action.target, result },
				});
				return;
			}
			case "witch_act": {
				if (!player.alive || player.role !== "witch") {
					throw new RuleError("not_witch", "只有存活的女巫可以用药");
				}
				const victim = this.state.night.wolfTarget;
				if (action.save && action.poisonTarget !== null) {
					throw new RuleError("both_potions", "同一晚不能同时使用解药和毒药");
				}
				if (action.save) {
					if (!this.state.witch.antidote) throw new RuleError("no_antidote", "解药已经用过了");
					if (victim === null) throw new RuleError("no_victim", "今晚没有人被狼人刀杀，无法使用解药");
					if (
						victim === action.seat &&
						this.config.selfSaveNight1Only &&
						this.state.day > 1
					) {
						throw new RuleError("no_self_save", "第一夜之后女巫不能自救");
					}
				}
				if (action.poisonTarget !== null) {
					if (!this.state.witch.poison) throw new RuleError("no_poison", "毒药已经用过了");
					if (action.poisonTarget === action.seat) throw new RuleError("self_poison", "不能毒杀自己");
					const target = this.player(action.poisonTarget);
					if (!target.alive) throw new RuleError("target_dead", "不能毒杀已出局玩家");
				}
				this.state.phase = "night_witch";
				if (action.save) {
					this.state.witch.antidote = false;
					this.state.night.witchSave = true;
					this.emit("witch_action", { kind: "seat", seat: action.seat }, {
						actor: action.seat,
						target: victim,
						text: `你使用解药救了 ${seatLabel(victim!)}。`,
					});
				}
				if (action.poisonTarget !== null) {
					this.state.witch.poison = false;
					this.state.night.witchPoison = action.poisonTarget;
					this.emit("witch_action", { kind: "seat", seat: action.seat }, {
						actor: action.seat,
						target: action.poisonTarget,
						text: `你使用毒药毒杀了 ${seatLabel(action.poisonTarget)}。`,
					});
				}
				if (!action.save && action.poisonTarget === null) {
					this.emit("witch_action", { kind: "seat", seat: action.seat }, {
						actor: action.seat,
						text: "你今晚没有用药。",
					});
				}
				return;
			}
			case "last_words": {
				if (player.alive) throw new RuleError("alive_last_words", "存活玩家不能发表遗言");
				if (action.text.length === 0 || action.text.length > this.config.maxLastWordsChars) {
					throw new RuleError("bad_last_words", `遗言长度必须在 1-${this.config.maxLastWordsChars} 字之间`);
				}
				this.state.phase = "last_words";
				this.emit("last_words", { kind: "public" }, {
					actor: action.seat,
					text: action.text,
				});
				return;
			}
			case "hunter_shoot": {
				if (player.alive || player.role !== "hunter") {
					throw new RuleError("not_dead_hunter", "只有出局的猎人可以开枪");
				}
				if ((player.death?.causes ?? []).includes("poison")) {
					throw new RuleError("poisoned_hunter", "被毒杀的猎人不能开枪");
				}
				this.state.phase = "hunter_shot";
				if (action.target === null) {
					this.emit("hunter_shot", { kind: "judge" }, {
						actor: action.seat,
						text: `${seatLabel(action.seat)} 猎人放弃开枪`,
					});
					return;
				}
				const target = this.player(action.target);
				if (!target.alive) throw new RuleError("target_dead", "不能开枪带走已出局玩家");
				if (target.seat === action.seat) throw new RuleError("self_shot", "不能开枪打自己");
				target.alive = false;
				target.death = { day: this.state.day, phase: "hunter_shot", causes: ["hunter_shot"] };
				this.emit("hunter_shot", { kind: "public" }, {
					actor: action.seat,
					target: action.target,
					text: `${seatLabel(action.seat)} 猎人开枪带走了 ${seatLabel(action.target)}。`,
					data: { causes: ["hunter_shot"] },
				});
				this.queue.unshift({ t: "turn", kind: "last_words", seat: action.target });
				return;
			}
			case "day_speech": {
				if (!player.alive) throw new RuleError("dead_speak", "已出局玩家不能公开发言");
				if (action.text.length === 0 || action.text.length > this.config.maxSpeechChars) {
					throw new RuleError("bad_speech", `发言长度必须在 1-${this.config.maxSpeechChars} 字之间`);
				}
				this.state.phase = "day_discuss";
				this.emit("speech", { kind: "public" }, {
					actor: action.seat,
					text: action.text,
				});
				return;
			}
			case "day_vote": {
				if (!player.alive) throw new RuleError("dead_vote", "已出局玩家不能投票");
				if (action.target === "abstain") {
					if (!this.config.allowAbstain) throw new RuleError("abstain_forbidden", "当前规则不允许弃票");
				} else {
					if (!this.config.allowSelfVote && action.target === action.seat) {
						throw new RuleError("self_vote", "不能投票给自己");
					}
					const target = this.player(action.target);
					if (!target.alive) throw new RuleError("target_dead", "不能投票给已出局玩家");
				}
				if (this.state.votes[action.seat] !== undefined) {
					throw new RuleError("already_voted", "本回合已经投过票了");
				}
				this.state.phase = "day_vote";
				this.state.votes[action.seat] = action.target;
				this.emit("vote_cast", { kind: "judge" }, {
					actor: action.seat,
					target: typeof action.target === "number" ? action.target : null,
					text:
						action.target === "abstain"
							? `${seatLabel(action.seat)} 弃票`
							: `${seatLabel(action.seat)} 投给 ${seatLabel(action.target)}`,
					data: { vote: action.target },
				});
				return;
			}
		}
	}

	// ---------------------------------------------------------------------
	// 工具
	// ---------------------------------------------------------------------

	private speakingOrder(): number[] {
		const start = this.state.dayStartSeat ?? this.aliveSeats()[0] ?? 1;
		const order: number[] = [];
		for (let offset = 0; offset < this.config.playerCount; offset++) {
			const seat = ((start - 1 + offset) % this.config.playerCount) + 1;
			if (this.player(seat).alive) order.push(seat);
		}
		return order;
	}

	private eligibleHunter(deadSeats: number[]): number | null {
		for (const seat of deadSeats) {
			const player = this.player(seat);
			if (player.role !== "hunter") continue;
			if (player.alive) continue;
			if ((player.death?.causes ?? []).includes("poison")) continue;
			return seat;
		}
		return null;
	}

	private formatVoteRecord(
		votes: Record<number, number | "abstain">,
		counts: Map<number, number>,
		exiled: number | null,
	): string {
		const parts = Object.entries(votes)
			.sort(([a], [b]) => Number(a) - Number(b))
			.map(([seat, target]) => {
				const targetText = target === "abstain" ? "弃票" : seatLabel(target);
				return `${seatLabel(Number(seat))}→${targetText}`;
			});
		const tally = [...counts.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([seat, count]) => `${seatLabel(seat)} ${count}票`)
			.join("，");
		const result =
			exiled === null
				? "平票或无人得票，无人被放逐。"
				: `${seatLabel(exiled)} 被放逐出局。`;
		return `投票结果：${parts.length > 0 ? parts.join("，") : "无人投票"}。${tally ? `票数：${tally}。` : ""}${result}`;
	}

	private emit(
		type: EventType,
		visibility: Visibility,
		payload: {
			actor?: number;
			target?: number | null;
			text: string;
			data?: Record<string, unknown>;
		},
	): GameEvent {
		const event: GameEvent = {
			seq: this.events.length + 1,
			ts: this.clock(),
			gameId: this.state.gameId,
			day: this.state.day,
			phase: this.state.phase,
			type,
			visibility,
			actor: payload.actor ?? null,
			target: payload.target ?? null,
			text: payload.text,
			data: payload.data,
		};
		this.events.push(event);
		return event;
	}
}

export function isVisibleTo(event: GameEvent, player: PlayerState): boolean {
	switch (event.visibility.kind) {
		case "public":
			return true;
		case "seat":
			return event.visibility.seat === player.seat;
		case "wolves":
			return player.role === "werewolf";
		case "judge":
			return false;
	}
}

/** 视图构造：把引擎状态 + 事件日志转成单个玩家能看到的信息。 */
export function makePlayerView(
	state: GameState,
	events: readonly GameEvent[],
	turn: TurnRequest,
	seat: number,
	lastDeliveredSeq: number,
): PlayerView {
	const player = state.players[seat - 1];
	if (!player) throw new RuleError("bad_seat", `没有 ${seat} 号玩家`);
	const visibleEvents = events.filter((event) => isVisibleTo(event, player));
	const hiddenFromBrief = new Set<EventType>([
		"role_assigned",
		"seer_result",
		"witch_info",
		"witch_action",
		"vote_cast",
		"action_rejected",
		"agent_error",
		"default_action",
		"turn_start",
	]);
	const ownEcho = new Set<EventType>(["speech", "last_words", "wolf_speech", "wolf_vote"]);
	const newEvents = visibleEvents.filter(
		(event) =>
			event.seq > lastDeliveredSeq &&
			!hiddenFromBrief.has(event.type) &&
			!(event.actor === seat && ownEcho.has(event.type)),
	);
	const aliveSeats = state.players.filter((p) => p.alive).map((p) => p.seat);
	const deadSeats = state.players.filter((p) => !p.alive).map((p) => p.seat);
	const players = state.players.map((p) => ({
		seat: p.seat,
		alive: p.alive,
		deathDay: p.death?.day ?? null,
		deathPhase: p.death?.phase ?? null,
	}));
	const privateInfo = buildPrivateInfo(state, seat);
	return {
		seat,
		role: player.role,
		alive: player.alive,
		day: state.day,
		phase: state.phase,
		players,
		aliveSeats,
		deadSeats,
		legalTargets: turn.legalTargets,
		privateInfo,
		newEvents,
		visibleEvents,
		turn,
		brief: "",
	};
}

export function buildPrivateInfo(state: GameState, seat: number): string[] {
	const player = state.players[seat - 1];
	if (!player) throw new RuleError("bad_seat", `没有 ${seat} 号玩家`);
	const info: string[] = [];
	info.push(`你的身份：${ROLE_LABEL[player.role]}（${player.role === "werewolf" ? "狼人阵营" : "好人阵营"}）`);
	info.push(`状态：${player.alive ? "存活" : "已出局"}`);
	if (player.role === "werewolf") {
		const teammates = state.players.filter((p) => p.role === "werewolf" && p.seat !== seat);
		if (teammates.length === 0) {
			info.push("你是场上唯一的狼人。");
		} else {
			info.push(
				`狼队友：${teammates
					.map((p) => `${seatLabel(p.seat)}（${p.alive ? "存活" : "出局"}）`)
					.join("、")}`,
			);
		}
	}
	if (player.role === "seer") {
		if (state.seerChecks.length === 0) {
			info.push("查验记录：暂无");
		} else {
			info.push(
				`查验记录：${state.seerChecks
					.map(
						(check) =>
							`第${check.day}夜 ${seatLabel(check.target)}→${check.result === "wolf" ? "狼人" : "好人"}`,
					)
					.join("；")}`,
			);
		}
	}
	if (player.role === "witch") {
		info.push(
			`药剂：解药${state.witch.antidote ? "可用" : "已用"}；毒药${state.witch.poison ? "可用" : "已用"}`,
		);
		if (state.phase.startsWith("night") || state.phase === "last_words") {
			const victim = state.night.wolfTarget;
			info.push(victim === null ? "今晚无人被狼人刀杀。" : `今晚狼队刀杀：${seatLabel(victim)}。`);
		}
	}
	if (player.role === "hunter") {
		info.push("技能：被狼人杀害或被放逐时，出局后可以开枪；被女巫毒杀时不能开枪。");
	}
	return info;
}
