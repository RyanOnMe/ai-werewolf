import {
	DEFAULT_CONFIG,
	RULESET_12P,
	type Action,
	type DeathCause,
	type EventType,
	type GameEvent,
	type GameMode,
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
	canVote,
	factionOf,
	isGod,
	RuleError,
	seatLabel,
} from "./types.ts";
import { createRng, nextSeatWhere, type Rng } from "./rng.ts";

export const ROLE_SETUP_9: readonly Role[] = [
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

export const ROLE_SETUP_12: readonly Role[] = [
	"werewolf",
	"werewolf",
	"werewolf",
	"werewolf",
	"villager",
	"villager",
	"villager",
	"villager",
	"seer",
	"witch",
	"hunter",
	"idiot",
];

type AutoKind =
	| "start_night"
	| "resolve_wolves"
	| "resolve_night"
	| "start_day"
	| "start_day_discussion"
	| "resolve_sheriff_signup"
	| "resolve_sheriff_speeches"
	| "resolve_sheriff_vote"
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
	mode?: GameMode;
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
		const requestedMode: GameMode | undefined =
			options.mode ??
			options.config?.mode ??
			(options.roles?.length === 12 || options.config?.playerCount === 12 ? "12p" : undefined);
		const mode: GameMode = requestedMode === "12p" ? "12p" : "9p";
		const baseConfig = mode === "12p" ? RULESET_12P : DEFAULT_CONFIG;
		const config: RulesConfig = {
			...baseConfig,
			...options.config,
			mode,
			playerCount: baseConfig.playerCount,
		};
		if (options.config?.playerCount !== undefined && options.config.playerCount !== baseConfig.playerCount) {
			throw new RuleError(
				"unsupported_player_count",
				`${mode} 只支持 ${baseConfig.playerCount} 名玩家`,
			);
		}
		const seed = options.seed;
		const gameId = options.gameId ?? `game-${Date.now().toString(36)}`;
		const rng = createRng(seed);
		const officialSetup = mode === "12p" ? ROLE_SETUP_12 : ROLE_SETUP_9;
		const roles = options.roles ? [...options.roles] : rng.shuffle(officialSetup);
		if (roles.length !== config.playerCount) {
			throw new RuleError("bad_role_setup", `角色数量 ${roles.length} 与玩家数 ${config.playerCount} 不一致`);
		}
		for (const role of roles) {
			if (!(role in ROLE_LABEL)) {
				throw new RuleError("bad_role_setup", `未知身份：${String(role)}`);
			}
		}
		if (!options.roles) {
			const count = (role: Role) => roles.filter((r) => r === role).length;
			if (mode === "9p") {
				if (
					count("werewolf") !== 3 ||
					count("villager") !== 3 ||
					count("seer") !== 1 ||
					count("witch") !== 1 ||
					count("hunter") !== 1
				) {
					throw new RuleError("bad_role_setup", "9 人局需要恰好 3狼、3村民、1预言家、1女巫、1猎人");
				}
			} else if (
				count("werewolf") !== 4 ||
				count("villager") !== 4 ||
				count("seer") !== 1 ||
				count("witch") !== 1 ||
				count("hunter") !== 1 ||
				count("idiot") !== 1
			) {
				throw new RuleError(
					"bad_role_setup",
					"12 人局需要恰好 4狼、4村民、1预言家、1女巫、1猎人、1白痴",
				);
			}
		}
		const players: PlayerState[] = roles.map((role, index) => ({
			seat: index + 1,
			role,
			alive: true,
			death: null,
			revealed: false,
		}));
		const state: GameState = {
			gameId,
			seed,
			mode,
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
			sheriffVotes: {},
			sheriff: null,
			sheriffElectionHeld: false,
			sheriffCandidates: [],
			winner: null,
			endReason: null,
		};
		const engine = new GameEngine(state, config, rng, options.clock ?? (() => new Date().toISOString()));

		const setupText =
			mode === "12p"
				? "12人局开始：4狼人、4村民、预言家、女巫、猎人、白痴。第 1 天将进行警长竞选；狼人杀光所有村民或所有神职即获胜；好人放逐所有狼人即获胜。"
				: "9人局开始：3狼人、3村民、预言家、女巫、猎人。狼人杀光所有村民或所有神职即获胜；好人放逐所有狼人即获胜。";
		engine.emit("game_start", { kind: "public" }, {
			text: setupText,
			data: {
				playerCount: config.playerCount,
				mode,
				roleSetup: officialSetup,
				sheriffEnabled: config.sheriffEnabled,
				nightLastWords: config.nightLastWords,
			},
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
			case "start_day_discussion":
				this.startDayDiscussion();
				return;
			case "resolve_sheriff_signup":
				this.resolveSheriffSignup();
				return;
			case "resolve_sheriff_speeches":
				this.resolveSheriffSpeeches();
				return;
			case "resolve_sheriff_vote":
				this.resolveSheriffVote();
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
			this.queue.push({ t: "auto", kind: "end_game" });
			return;
		}

		if (this.config.nightLastWords) {
			for (const seat of deadSeats) this.queue.push({ t: "turn", kind: "last_words", seat });
		}
		for (const seat of deadSeats) this.queueBadgeTransfer(seat);
		const hunter = this.eligibleHunter(deadSeats);
		if (hunter !== null) {
			this.queue.push({ t: "turn", kind: "hunter_shoot", seat: hunter });
		}
		this.queue.push({ t: "auto", kind: "post_deaths", next: "day" });
	}

	private startDay(): void {
		if (this.state.day === 1 && this.config.sheriffEnabled && !this.state.sheriffElectionHeld) {
			this.startSheriffElection();
			return;
		}
		this.startDayDiscussion();
	}

	private startSheriffElection(): void {
		this.state.phase = "sheriff_signup";
		this.state.sheriffCandidates = [];
		this.state.sheriffVotes = {};
		const alive = this.aliveSeats();
		this.emit("phase", { kind: "public" }, {
			text: "第 1 天警长竞选开始。所有存活玩家选择是否上警；上警玩家随后公开发言，警下玩家投票选出警长。",
			data: { candidates: [], alive },
		});
		for (const seat of alive) {
			this.queue.push({ t: "turn", kind: "sheriff_signup", seat });
		}
		this.queue.push({ t: "auto", kind: "resolve_sheriff_signup" });
	}

	private resolveSheriffSignup(): void {
		const candidates = [...this.state.sheriffCandidates].sort((a, b) => a - b);
		this.emit("sheriff_signup", { kind: "public" }, {
			text:
				candidates.length === 0
					? "无人上警。"
					: `上警玩家：${candidates.map(seatLabel).join("、")}。其余玩家警下。`,
			data: { candidates },
		});
		if (candidates.length === 0) {
			this.electSheriff(null, {}, {}, "无人上警，本局没有警长");
			return;
		}
		this.state.phase = "sheriff_speech";
		this.emit("phase", { kind: "public" }, {
			text: `上警玩家：${candidates.map(seatLabel).join("、")}。请依次发表竞选发言。`,
			data: { candidates },
		});
		for (const seat of candidates) {
			this.queue.push({ t: "turn", kind: "sheriff_speech", seat });
		}
		this.queue.push({ t: "auto", kind: "resolve_sheriff_speeches" });
	}

	private resolveSheriffSpeeches(): void {
		const candidates = [...this.state.sheriffCandidates].sort((a, b) => a - b);
		if (candidates.length === 0) {
			this.electSheriff(null, {}, {}, "没有有效候选人");
			return;
		}
		if (candidates.length === 1) {
			this.electSheriff(candidates[0]!, {}, {}, "唯一上警候选人自动当选");
			return;
		}
		const candidateSet = new Set(candidates);
		const voters = this.aliveSeats().filter((seat) => !candidateSet.has(seat));
		if (voters.length === 0) {
			this.electSheriff(null, {}, {}, "全员上警，无人可投票，本局没有警长");
			return;
		}
		this.state.phase = "sheriff_vote";
		this.state.sheriffVotes = {};
		this.emit("phase", { kind: "public" }, {
			text: `竞选发言结束。警下玩家开始投票；候选人：${candidates.map(seatLabel).join("、")}。`,
			data: { candidates, voters },
		});
		for (const seat of voters) {
			this.queue.push({ t: "turn", kind: "sheriff_vote", seat });
		}
		this.queue.push({ t: "auto", kind: "resolve_sheriff_vote" });
	}

	private resolveSheriffVote(): void {
		const votes = this.state.sheriffVotes;
		const counts = new Map<number, number>();
		for (const target of Object.values(votes)) {
			if (typeof target === "number") {
				counts.set(target, (counts.get(target) ?? 0) + 1);
			}
		}
		let max = 0;
		for (const count of counts.values()) max = Math.max(max, count);
		const top = [...counts.entries()].filter(([, count]) => count === max).map(([seat]) => seat);
		const elected = top.length === 1 && max > 0 ? top[0]! : null;
		const reason =
			elected === null
				? "警长竞选平票或无人得票，本局没有警长"
				: `${seatLabel(elected)} 当选警长`;
		this.electSheriff(elected, votes, Object.fromEntries(counts), reason);
	}

	private electSheriff(
		seat: number | null,
		votes: Record<number, number | "abstain">,
		tally: Record<number, number>,
		reason: string,
	): void {
		this.state.sheriffElectionHeld = true;
		this.state.sheriff = seat;
		this.emit("sheriff_elected", { kind: "public" }, {
			target: seat,
			text: reason,
			data: {
				seat,
				candidates: [...this.state.sheriffCandidates].sort((a, b) => a - b),
				votes: { ...votes },
				tally,
				reason,
			},
		});
		this.queue.push({ t: "auto", kind: "start_day_discussion" });
	}

	private startDayDiscussion(): void {
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
		const sheriffText =
			this.state.sheriff === null ? "本局无警长。" : `警长：${seatLabel(this.state.sheriff)}。`;
		this.emit("phase", { kind: "public" }, {
			text: `第 ${this.state.day} 天白天开始。${sheriffText}存活：${alive.map(seatLabel).join("、")}。发言从 ${seatLabel(order[0] ?? this.state.dayStartSeat)} 开始。`,
			data: {
				alive,
				startSeat: this.state.dayStartSeat,
				order,
				sheriff: this.state.sheriff,
			},
		});
		for (const seat of order) {
			this.queue.push({ t: "turn", kind: "day_speech", seat });
		}
		this.queue.push({ t: "auto", kind: "start_vote" });
	}

	private startVote(): void {
		this.state.phase = "day_vote";
		this.state.votes = {};
		const order = this.speakingOrder().filter((seat) => canVote(this.player(seat)));
		const sheriffText =
			this.state.sheriff === null
				? ""
				: `警长 ${seatLabel(this.state.sheriff)} 的票权为 ${this.config.sheriffVoteWeight}。`;
		this.emit("phase", { kind: "public" }, {
			text: `发言结束，现在开始放逐投票。${sheriffText}`,
			data: { order, sheriff: this.state.sheriff, sheriffVoteWeight: this.config.sheriffVoteWeight },
		});
		for (const seat of order) {
			this.queue.push({ t: "turn", kind: "day_vote", seat });
		}
		this.queue.push({ t: "auto", kind: "resolve_vote" });
	}

	private resolveVote(): void {
		const votes = this.state.votes;
		const counts = new Map<number, number>();
		for (const [seatText, target] of Object.entries(votes)) {
			if (typeof target !== "number") continue;
			const voter = Number(seatText);
			const weight = voter === this.state.sheriff ? this.config.sheriffVoteWeight : 1;
			counts.set(target, (counts.get(target) ?? 0) + weight);
		}
		let max = 0;
		for (const count of counts.values()) max = Math.max(max, count);
		const top = [...counts.entries()].filter(([, count]) => count === max).map(([seat]) => seat);
		const exiled = top.length === 1 && max > 0 ? top[0]! : null;
		const exiledPlayer = exiled === null ? null : this.player(exiled);
		const idiotReveal =
			exiledPlayer !== null && exiledPlayer.role === "idiot" && !exiledPlayer.revealed;
		const voteText = this.formatVoteRecord(votes, counts, exiled, idiotReveal);
		this.emit("vote_record", { kind: "public" }, {
			text: voteText,
			target: exiled,
			data: {
				votes: { ...votes },
				tally: Object.fromEntries(counts),
				exiled,
				idiotRevealed: idiotReveal,
				sheriff: this.state.sheriff,
				sheriffVoteWeight: this.config.sheriffVoteWeight,
			},
		});

		if (exiled === null || exiledPlayer === null) {
			this.queue.push({ t: "auto", kind: "post_deaths", next: "night" });
			return;
		}

		if (idiotReveal) {
			exiledPlayer.revealed = true;
			this.emit("idiot_revealed", { kind: "public" }, {
				actor: exiled,
				target: exiled,
				text: `${seatLabel(exiled)} 翻牌白痴，免于放逐，但失去投票权。`,
				data: { seat: exiled },
			});
			this.queue.push({ t: "auto", kind: "post_deaths", next: "night" });
			return;
		}

		exiledPlayer.alive = false;
		exiledPlayer.death = { day: this.state.day, phase: "day_vote", causes: ["exile"] };
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
		this.queueBadgeTransfer(exiled);
		const hunter = this.eligibleHunter([exiled]);
		if (hunter !== null) {
			this.queue.push({ t: "turn", kind: "hunter_shoot", seat: hunter });
		}
		this.queue.push({ t: "auto", kind: "post_deaths", next: "night" });
	}

	private queueBadgeTransfer(deadSeat: number): void {
		if (this.state.sheriff !== deadSeat) return;
		const targets = this.aliveSeats().filter((seat) => seat !== deadSeat);
		if (targets.length === 0) {
			this.state.sheriff = null;
			this.emit("badge_transfer", { kind: "public" }, {
				actor: deadSeat,
				text: `${seatLabel(deadSeat)} 出局且无人可接警徽，警徽销毁。`,
				data: { from: deadSeat, to: null },
			});
			return;
		}
		this.queue.push({ t: "turn", kind: "badge_transfer", seat: deadSeat });
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
		if (
			task.kind !== "last_words" &&
			task.kind !== "hunter_shoot" &&
			task.kind !== "badge_transfer" &&
			!player.alive
		) {
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
			case "sheriff_signup": {
				if (!player.alive) return null;
				this.state.phase = "sheriff_signup";
				return {
					id: turnId,
					kind: "sheriff_signup",
					seat: task.seat,
					day: this.state.day,
					phase: this.state.phase,
					legalTargets: [],
					promptHint:
						"现在是第 1 天警长竞选的上警环节。请调用 sheriff_run 选择 run=true（上警）或 run=false（不上警）。上警会公开发言并接受警下投票；警长有 1.5 票放逐票权，死亡时可以移交警徽。请根据阵营收益和暴露风险决定。",
				};
			}
			case "sheriff_speech": {
				if (!player.alive || !this.state.sheriffCandidates.includes(task.seat)) return null;
				this.state.phase = "sheriff_speech";
				return {
					id: turnId,
					kind: "sheriff_speech",
					seat: task.seat,
					day: this.state.day,
					phase: this.state.phase,
					legalTargets: [],
					sheriffCandidates: [...this.state.sheriffCandidates].sort((a, b) => a - b),
					promptHint:
						"你是警上候选人。请调用 sheriff_say 发表竞选发言：说明上警目的、身份或站边、对当前局势的判断，以及拿到警徽后的验人/归票计划。狼人可以悍跳和编造警徽流；好人要给出可信的带队方案。不要只说“我上警”。",
				};
			}
			case "sheriff_vote": {
				if (!player.alive || this.state.sheriffCandidates.includes(task.seat)) return null;
				this.state.phase = "sheriff_vote";
				const candidates = [...this.state.sheriffCandidates].sort((a, b) => a - b);
				return {
					id: turnId,
					kind: "sheriff_vote",
					seat: task.seat,
					day: this.state.day,
					phase: this.state.phase,
					legalTargets: candidates,
					sheriffCandidates: candidates,
					promptHint:
						"请调用 sheriff_vote 投给一名警上候选人，或 abstain 弃票。比较候选人的身份可信度、站边、警徽流和带队价值；警徽会给对方阵营带来 1.5 票和移交警徽的能力。",
				};
			}
			case "badge_transfer": {
				if (this.state.sheriff !== task.seat) return null;
				this.state.phase = "badge_transfer";
				return {
					id: turnId,
					kind: "badge_transfer",
					seat: task.seat,
					day: this.state.day,
					phase: this.state.phase,
					legalTargets: this.aliveSeats().filter((seat) => seat !== task.seat),
					isSheriff: true,
					promptHint:
						"你是警长且已出局。请调用 transfer_badge 把警徽交给一名存活玩家，或传 target: null 销毁警徽。优先交给可信的好人；交给狼人会让对方获得 1.5 票和警徽。没有可信目标时宁可销毁。",
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
				if (!player.alive || !canVote(player)) return null;
				this.state.phase = "day_vote";
				const sheriffHint =
					this.state.sheriff === task.seat
						? `你是警长，本票权重为 ${this.config.sheriffVoteWeight}。`
						: "";
				return {
					id: turnId,
					kind: "day_vote",
					seat: task.seat,
					day: this.state.day,
					phase: this.state.phase,
					legalTargets: this.aliveSeats().filter(
						(seat) => this.config.allowSelfVote || seat !== task.seat,
					),
					isSheriff: this.state.sheriff === task.seat,
					promptHint: `${sheriffHint}请调用 vote 选择一名要放逐的存活玩家，或选择 abstain 弃票。投票前先想清楚：这一票是否能推动你的阵营获胜，以及投给谁会让别人怎么判断你的身份。`,
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
			case "sheriff_signup": {
				if (!player.alive) throw new RuleError("dead_signup", "已出局玩家不能参加警长竞选");
				this.state.phase = "sheriff_signup";
				if (action.run && !this.state.sheriffCandidates.includes(action.seat)) {
					this.state.sheriffCandidates.push(action.seat);
				}
				this.emit("sheriff_signup", { kind: "public" }, {
					actor: action.seat,
					text: action.run ? `${seatLabel(action.seat)} 上警。` : `${seatLabel(action.seat)} 不上警。`,
					data: { seat: action.seat, run: action.run },
				});
				return;
			}
			case "sheriff_speech": {
				if (!player.alive || !this.state.sheriffCandidates.includes(action.seat)) {
					throw new RuleError("not_sheriff_candidate", "只有存活的警上候选人可以发表竞选发言");
				}
				if (action.text.length === 0 || action.text.length > this.config.maxSpeechChars) {
					throw new RuleError("bad_sheriff_speech", `竞选发言长度必须在 1-${this.config.maxSpeechChars} 字之间`);
				}
				this.state.phase = "sheriff_speech";
				this.emit("sheriff_speech", { kind: "public" }, {
					actor: action.seat,
					text: action.text,
				});
				return;
			}
			case "sheriff_vote": {
				if (!player.alive || this.state.sheriffCandidates.includes(action.seat)) {
					throw new RuleError("not_sheriff_voter", "只有存活的警下玩家可以投警长票");
				}
				if (action.target === "abstain") {
					if (!this.config.allowAbstain) throw new RuleError("abstain_forbidden", "当前规则不允许弃票");
				} else if (!this.state.sheriffCandidates.includes(action.target)) {
					throw new RuleError("not_sheriff_candidate", "只能投给警上候选人");
				}
				if (this.state.sheriffVotes[action.seat] !== undefined) {
					throw new RuleError("already_voted", "本回合已经投过警长票了");
				}
				this.state.phase = "sheriff_vote";
				this.state.sheriffVotes[action.seat] = action.target;
				this.emit("sheriff_vote", { kind: "public" }, {
					actor: action.seat,
					target: typeof action.target === "number" ? action.target : null,
					text:
						action.target === "abstain"
							? `${seatLabel(action.seat)} 警长票弃票`
							: `${seatLabel(action.seat)} 警长票投给 ${seatLabel(action.target)}`,
					data: { vote: action.target },
				});
				return;
			}
			case "badge_transfer": {
				if (this.state.sheriff !== action.seat) {
					throw new RuleError("not_sheriff", "只有当前警长可以移交警徽");
				}
				if (player.alive) throw new RuleError("alive_sheriff", "存活警长不能移交警徽");
				this.state.phase = "badge_transfer";
				if (action.target === null) {
					this.state.sheriff = null;
					this.emit("badge_transfer", { kind: "public" }, {
						actor: action.seat,
						text: `${seatLabel(action.seat)} 销毁了警徽。`,
						data: { from: action.seat, to: null },
					});
					return;
				}
				const target = this.player(action.target);
				if (!target.alive) throw new RuleError("target_dead", "不能把警徽交给已出局玩家");
				if (target.seat === action.seat) throw new RuleError("self_badge", "不能把警徽交给自己");
				this.state.sheriff = action.target;
				this.emit("badge_transfer", { kind: "public" }, {
					actor: action.seat,
					target: action.target,
					text: `${seatLabel(action.seat)} 把警徽交给了 ${seatLabel(action.target)}。`,
					data: { from: action.seat, to: action.target },
				});
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
				if (this.state.sheriff === action.target && this.computeWinner() === null) {
					const badgeTargets = this.aliveSeats().filter((seat) => seat !== action.target);
					if (badgeTargets.length > 0) {
						this.queue.splice(1, 0, {
							t: "turn",
							kind: "badge_transfer",
							seat: action.target,
						});
					} else {
						this.state.sheriff = null;
						this.emit("badge_transfer", { kind: "public" }, {
							actor: action.target,
							text: `${seatLabel(action.target)} 出局且无人可接警徽，警徽销毁。`,
							data: { from: action.target, to: null },
						});
					}
				}
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
				if (!canVote(player)) throw new RuleError("idiot_cannot_vote", "翻牌白痴失去投票权");
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
		idiotReveal: boolean,
	): string {
		const parts = Object.entries(votes)
			.sort(([a], [b]) => Number(a) - Number(b))
			.map(([seat, target]) => {
				const targetText = target === "abstain" ? "弃票" : seatLabel(target);
				const weight =
					Number(seat) === this.state.sheriff
						? `(${this.config.sheriffVoteWeight}票)`
						: "";
				return `${seatLabel(Number(seat))}${weight}→${targetText}`;
			});
		const tally = [...counts.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([seat, count]) => `${seatLabel(seat)} ${Number.isInteger(count) ? count : count.toFixed(1)}票`)
			.join("，");
		const result =
			exiled === null
				? "平票或无人得票，无人被放逐。"
				: idiotReveal
					? `${seatLabel(exiled)} 被放逐，但亮出白痴身份免于出局。`
					: `${seatLabel(exiled)} 被放逐出局。`;
		const sheriffText =
			this.state.sheriff === null
				? ""
				: `警长 ${seatLabel(this.state.sheriff)} 的票权为 ${this.config.sheriffVoteWeight}。`;
		return `投票结果：${parts.length > 0 ? parts.join("，") : "无人投票"}。${sheriffText}${tally ? `票数：${tally}。` : ""}${result}`;
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
	sheriffVoteWeight = 1.5,
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
	const ownEcho = new Set<EventType>([
		"speech",
		"last_words",
		"wolf_speech",
		"wolf_vote",
		"sheriff_signup",
		"sheriff_speech",
		"sheriff_vote",
	]);
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
		revealed: p.revealed,
		canVote: canVote(p),
	}));
	const privateInfo = buildPrivateInfo(state, seat, sheriffVoteWeight);
	return {
		seat,
		role: player.role,
		alive: player.alive,
		mode: state.mode,
		playerCount: state.players.length,
		day: state.day,
		phase: state.phase,
		players,
		aliveSeats,
		deadSeats,
		sheriff: state.sheriff,
		sheriffCandidates: [...state.sheriffCandidates],
		sheriffVoteWeight,
		legalTargets: turn.legalTargets,
		privateInfo,
		newEvents,
		visibleEvents,
		turn,
		brief: "",
	};
}

export function buildPrivateInfo(state: GameState, seat: number, sheriffVoteWeight = 1.5): string[] {
	const player = state.players[seat - 1];
	if (!player) throw new RuleError("bad_seat", `没有 ${seat} 号玩家`);
	const info: string[] = [];
	info.push(`你的身份：${ROLE_LABEL[player.role]}（${player.role === "werewolf" ? "狼人阵营" : "好人阵营"}）`);
	info.push(`状态：${player.alive ? "存活" : "已出局"}${player.revealed ? "（白痴已翻牌，失去投票权）" : ""}`);
	info.push(
		state.sheriff === null
			? "当前警长：无"
			: `当前警长：${seatLabel(state.sheriff)}${state.sheriff === seat ? "（你）" : ""}`,
	);
	if (state.sheriff === seat) {
		info.push(`警长票权：${sheriffVoteWeight} 票（放逐投票）；出局时可以移交警徽。`);
	}
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
	if (player.role === "idiot") {
		info.push(
			player.revealed
				? "白痴技能：你已翻牌，仍然存活但失去放逐投票权；再次被放逐会正常出局。"
				: "白痴技能：第一次被放逐时翻牌免死，但失去放逐投票权；被狼刀/毒杀/猎人开枪会正常出局。",
		);
	}
	return info;
}
