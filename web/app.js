(() => {
	"use strict";

	const ROLE_LABELS = {
		werewolf: "狼人",
		villager: "村民",
		seer: "预言家",
		witch: "女巫",
		hunter: "猎人",
	};
	const PHASE_LABELS = {
		setup: "准备",
		night_wolves: "狼人行动",
		night_seer: "预言家查验",
		night_witch: "女巫用药",
		dawn: "天亮",
		last_words: "遗言",
		hunter_shot: "猎人开枪",
		day_discuss: "白天讨论",
		day_vote: "放逐投票",
		ended: "游戏结束",
	};
	const CAUSE_LABELS = {
		wolf_kill: "狼刀",
		poison: "毒杀",
		exile: "放逐",
		hunter_shot: "枪杀",
	};
	const EVENT_LABELS = {
		game_start: "开始",
		phase: "阶段",
		speech: "发言",
		last_words: "遗言",
		wolf_speech: "狼队",
		wolf_vote: "狼刀",
		wolf_target: "刀口",
		seer_result: "查验",
		witch_action: "用药",
		vote_record: "投票",
		death: "死亡",
		hunter_shot: "开枪",
		game_end: "结束",
	};
	const WINNER_LABELS = {
		good: "好人阵营获胜",
		wolf: "狼人阵营获胜",
	};
	const TIMELINE_TYPES = new Set([
		"game_start",
		"phase",
		"speech",
		"last_words",
		"wolf_speech",
		"wolf_vote",
		"wolf_target",
		"seer_result",
		"witch_action",
		"vote_record",
		"death",
		"hunter_shot",
		"game_end",
	]);
	const SYSTEM_TYPES = new Set(["phase"]);
	const ISSUE_TYPES = new Set(["agent_error", "default_action", "action_rejected"]);

	const state = {
		config: {
			godEnabled: false,
			models: [],
			defaultModel: null,
			activeGameId: null,
			starting: false,
		},
		games: [],
		gameId: null,
		view: "public",
		events: [],
		cursor: 0,
		follow: true,
		status: "idle",
		connected: false,
		error: null,
		es: null,
		replayTimer: null,
		renderQueued: false,
		seatEls: [],
		retryCount: 0,
		retryTimer: null,
		formError: null,
		modeInitialized: false,
	};

	const $ = (id) => document.getElementById(id);

	const el = {
		gameSelect: $("game-select"),
		viewToggle: $("view-toggle"),
		refreshBtn: $("refresh-btn"),
		newGameBtn: $("new-game-btn"),
		newGamePanel: $("new-game-panel"),
		newGameForm: $("new-game-form"),
		modeSelect: $("mode-select"),
		seedInput: $("seed-input"),
		modelField: $("model-field"),
		modelSelect: $("model-select"),
		startGameBtn: $("start-game-btn"),
		newGameHint: $("new-game-hint"),
		errorBanner: $("error-banner"),
		errorText: $("error-text"),
		errorClose: $("error-close"),
		gameId: $("game-id"),
		phaseTitle: $("phase-title"),
		statusPill: $("status-pill"),
		seatsRing: $("seats-ring"),
		dayLabel: $("day-label"),
		phaseLabel: $("phase-label"),
		aliveCount: $("alive-count"),
		deadCount: $("dead-count"),
		winnerLabel: $("winner-label"),
		godPanel: $("god-panel"),
		godContent: $("god-content"),
		timeline: $("timeline"),
		replayBtn: $("replay-btn"),
		latestBtn: $("latest-btn"),
		scrubber: $("scrubber"),
		scrubberLabel: $("scrubber-label"),
		followLabel: $("follow-label"),
		connectionNote: $("connection-note"),
	};

	function randomSeed() {
		return Math.random().toString(36).slice(2, 10);
	}

	function fetchJson(url, options) {
		return fetch(url, options).then(async (response) => {
			const text = await response.text();
			let data = null;
			try {
				data = text ? JSON.parse(text) : null;
			} catch {
				data = { error: text };
			}
			if (!response.ok) {
				throw new Error((data && data.error) || `HTTP ${response.status}`);
			}
			return data;
		});
	}

	function showError(message) {
		state.error = message;
		el.errorText.textContent = message;
		el.errorBanner.hidden = false;
	}

	function hideError() {
		state.error = null;
		el.errorBanner.hidden = true;
	}

	function phaseLabel(phase) {
		return PHASE_LABELS[phase] || phase || "—";
	}

	function roleLabel(role) {
		return ROLE_LABELS[role] || role || "身份未知";
	}

	function causeLabel(cause) {
		return CAUSE_LABELS[cause] || cause;
	}

	function winnerLabel(winner) {
		return WINNER_LABELS[winner] || winner || "";
	}

	function gameDayLabel(day, phase) {
		if (day === null || day === undefined) return "—";
		return typeof phase === "string" && phase.startsWith("night") ? `第 ${day} 夜` : `第 ${day} 天`;
	}

	function statusState() {
		if (state.status === "connecting") return "connecting";
		if (state.status === "live") return "live";
		if (state.status === "finished") return "finished";
		if (state.status === "error") return "error";
		return "idle";
	}

	function statusText() {
		if (state.status === "connecting") return "连接中";
		if (state.status === "live") return "直播中";
		if (state.status === "finished") return "已结束";
		if (state.status === "error") return "出错";
		return "未连接";
	}

	function scheduleRender() {
		if (state.renderQueued) return;
		state.renderQueued = true;
		requestAnimationFrame(() => {
			state.renderQueued = false;
			render();
		});
	}

	// ------------------------------------------------------------------
	// 配置 / 对局列表
	// ------------------------------------------------------------------

	async function refreshConfig() {
		try {
			const config = await fetchJson("/api/config");
			state.config = config;
			if (!config.godEnabled && state.view === "god") {
				state.view = "public";
				if (state.gameId) {
					connect(state.gameId);
					return;
				}
			}
			renderConfig();
			updateViewToggle();
			updateStartState();
		} catch (error) {
			showError(`读取配置失败：${error.message}`);
		}
	}

	function renderConfig() {
		const models = Array.isArray(state.config.models) ? state.config.models : [];
		const previous = el.modelSelect.value;
		el.modelSelect.replaceChildren();
		if (models.length === 0) {
			const option = document.createElement("option");
			option.value = "";
			option.textContent = "无可用模型";
			el.modelSelect.append(option);
			el.modelSelect.disabled = true;
		} else {
			for (const model of models) {
				const option = document.createElement("option");
				option.value = model;
				option.textContent = model;
				el.modelSelect.append(option);
			}
			el.modelSelect.disabled = false;
			el.modelSelect.value = models.includes(previous)
				? previous
				: state.config.defaultModel || models[0];
		}

		const liveOption = el.modeSelect.querySelector('option[value="live"]');
		if (liveOption) liveOption.disabled = models.length === 0;
		if (!state.modeInitialized) {
			state.modeInitialized = true;
			el.modeSelect.value = models.length > 0 ? "live" : "scripted";
		}
		if (models.length === 0 && el.modeSelect.value === "live") {
			el.modeSelect.value = "scripted";
		}
		updateModelField();
	}

	function updateViewToggle() {
		const enabled = state.config.godEnabled === true;
		el.viewToggle.hidden = !enabled;
		for (const button of el.viewToggle.querySelectorAll("button[data-view]")) {
			button.classList.toggle("active", button.dataset.view === state.view);
		}
	}

	function updateModelField() {
		const live = el.modeSelect.value === "live";
		el.modelField.hidden = !live;
		el.newGameForm.classList.toggle("no-model", !live);
		updateStartState();
	}

	function updateStartState() {
		const models = Array.isArray(state.config.models) ? state.config.models : [];
		const live = el.modeSelect.value === "live";
		const busy = Boolean(state.config.activeGameId) || Boolean(state.config.starting);
		el.startGameBtn.disabled = busy || (live && models.length === 0);
		el.newGameHint.classList.remove("error");
		if (busy) {
			el.newGameHint.textContent = state.config.activeGameId
				? `已有对局进行中：${state.config.activeGameId}`
				: "正在启动对局…";
			return;
		}
		if (live) {
			el.newGameHint.textContent =
				models.length === 0
					? "没有可用模型；请先运行 pi auth，或用 --model 启动 serve。"
					: `真实模型：${el.modelSelect.value || state.config.defaultModel || "—"}；一局约 50-80 次请求。`;
			return;
		}
		el.newGameHint.textContent = "脚本对局：随机策略，几秒内结束，不需要模型。";
	}

	async function loadGames() {
		try {
			const data = await fetchJson("/api/games");
			state.games = Array.isArray(data.games) ? data.games : [];
			renderGameSelect();
		} catch (error) {
			showError(`读取对局列表失败：${error.message}`);
		}
	}

	function renderGameSelect() {
		const current = state.gameId;
		el.gameSelect.replaceChildren();
		if (state.games.length === 0) {
			const option = document.createElement("option");
			option.value = "";
			option.textContent = "暂无对局";
			el.gameSelect.append(option);
			el.gameSelect.disabled = true;
			return;
		}
		el.gameSelect.disabled = false;
		for (const game of state.games) {
			const option = document.createElement("option");
			option.value = game.gameId;
			const parts = [game.gameId];
			if (game.status === "finished" && game.winner) {
				parts.push(winnerLabel(game.winner));
			} else if (game.status === "error") {
				parts.push("出错");
			} else {
				parts.push("进行中");
			}
			if (game.days) parts.push(`第 ${game.days} 天`);
			option.textContent = parts.join(" · ");
			el.gameSelect.append(option);
		}
		const target =
			current && state.games.some((game) => game.gameId === current)
				? current
				: state.games[0].gameId;
		el.gameSelect.value = target;
	}

	function selectGame(gameId) {
		if (!gameId) return;
		state.gameId = gameId;
		el.gameSelect.value = gameId;
		connect(gameId);
	}

	// ------------------------------------------------------------------
	// SSE
	// ------------------------------------------------------------------

	function closeStream() {
		if (state.es) {
			state.es.close();
			state.es = null;
		}
		if (state.retryTimer) {
			clearTimeout(state.retryTimer);
			state.retryTimer = null;
		}
	}

	function connect(gameId, options = {}) {
		if (!options.retry) state.retryCount = 0;
		closeStream();
		stopReplay();
		state.gameId = gameId;
		state.events = [];
		state.cursor = 0;
		state.follow = true;
		state.status = "connecting";
		state.connected = false;
		hideError();
		scheduleRender();
		if (!gameId) return;

		const url = `/api/games/${encodeURIComponent(gameId)}/events?view=${state.view}`;
		const es = new EventSource(url);
		state.es = es;

		es.addEventListener("open", () => {
			state.connected = true;
			if (state.status === "connecting") state.status = "live";
			scheduleRender();
		});

		es.addEventListener("game", (message) => {
			let event;
			try {
				event = JSON.parse(message.data);
			} catch {
				return;
			}
			if (!event || typeof event.seq !== "number") return;
			const lastSeq = state.events.length ? state.events[state.events.length - 1].seq : 0;
			if (event.seq <= lastSeq) return;
			state.events.push(event);
			state.retryCount = 0;
			if (state.status === "connecting") state.status = "live";
			if (state.follow) state.cursor = state.events.length;
			scheduleRender();
		});

		es.addEventListener("done", (message) => {
			let data = {};
			try {
				data = JSON.parse(message.data);
			} catch {
				// ignore
			}
			state.status = data.state === "error" ? "error" : "finished";
			state.connected = false;
			if (state.follow) state.cursor = state.events.length;
			closeStream();
			void loadGames();
			void refreshConfig();
			scheduleRender();
		});

		es.addEventListener("server_error", (message) => {
			let data = {};
			try {
				data = JSON.parse(message.data);
			} catch {
				// ignore
			}
			state.status = "error";
			showError(data.message || "游戏中止");
			scheduleRender();
		});

		es.addEventListener("error", () => {
			if (state.status === "finished" || state.status === "error") return;
			state.connected = false;
			if (state.events.length === 0) {
				state.status = "connecting";
				if (state.retryCount < 3) {
					state.retryCount += 1;
					if (state.retryTimer) clearTimeout(state.retryTimer);
					state.retryTimer = setTimeout(() => {
						if (state.gameId === gameId && state.status === "connecting") {
							connect(gameId, { retry: true });
						}
					}, 600);
				}
			}
			scheduleRender();
		});
	}

	// ------------------------------------------------------------------
	// 事件 → 状态
	// ------------------------------------------------------------------

	function markDead(players, seat, day, phase, causes) {
		const player = players.get(seat);
		if (!player) return;
		player.alive = false;
		if (!player.death) {
			player.death = { day, phase, causes: [...causes] };
			return;
		}
		for (const cause of causes) {
			if (!player.death.causes.includes(cause)) player.death.causes.push(cause);
		}
	}

	function derive(visible) {
		const players = new Map();
		for (let seat = 1; seat <= 9; seat++) {
			players.set(seat, { seat, alive: true, death: null });
		}
		const roles = new Map();
		let day = 1;
		let phase = "setup";
		let winner = null;

		for (const event of visible) {
			if (typeof event.day === "number") day = event.day;
			if (typeof event.phase === "string") phase = event.phase;
			const data = event.data || {};

			if (event.type === "role_assigned" && Number.isInteger(data.seat)) {
				roles.set(data.seat, data.role);
			}

			if (event.type === "death") {
				if (Array.isArray(data.seats)) {
					for (const seat of data.seats) {
						markDead(players, seat, event.day, event.phase, []);
					}
				}
				if (Number.isInteger(data.seat)) {
					markDead(
						players,
						data.seat,
						event.day,
						event.phase,
						Array.isArray(data.causes) ? data.causes : [],
					);
				}
				if (Array.isArray(data.deaths)) {
					for (const item of data.deaths) {
						if (item && Number.isInteger(item.seat)) {
							markDead(
								players,
								item.seat,
								event.day,
								event.phase,
								Array.isArray(item.causes) ? item.causes : [],
							);
						}
					}
				}
			}

			if (event.type === "vote_record" && Number.isInteger(data.exiled)) {
				markDead(players, data.exiled, event.day, event.phase, ["exile"]);
			}

			if (event.type === "hunter_shot" && Number.isInteger(event.target)) {
				markDead(players, event.target, event.day, event.phase, ["hunter_shot"]);
			}

			if (event.type === "game_end") {
				if (data.winner === "good" || data.winner === "wolf") winner = data.winner;
				if (data.roles && typeof data.roles === "object") {
					for (const [seat, role] of Object.entries(data.roles)) {
						roles.set(Number(seat), role);
					}
				}
			}
		}

		const last = visible.length ? visible[visible.length - 1] : null;
		const currentSeat =
			state.view === "god" &&
			last &&
			last.type === "turn_start" &&
			last.data &&
			Number.isInteger(last.data.seat)
				? last.data.seat
				: null;
		const aliveSeats = [...players.values()].filter((p) => p.alive).map((p) => p.seat);
		const deadSeats = [...players.values()].filter((p) => !p.alive).map((p) => p.seat);
		return { players, roles, day, phase, winner, aliveSeats, deadSeats, currentSeat, last };
	}

	// ------------------------------------------------------------------
	// 渲染
	// ------------------------------------------------------------------

	function render() {
		const visible = state.events.slice(0, state.cursor);
		const derived = derive(visible);
		renderHeader(derived);
		renderSeats(derived);
		renderCenter(derived);
		renderTimeline(visible);
		renderGodPanel(visible, derived);
		renderControls();
	}

	function renderHeader(derived) {
		el.gameId.textContent = state.gameId || "未选择对局";
		if (!state.gameId) {
			el.phaseTitle.textContent = "等待对局";
		} else if (derived.day === null) {
			el.phaseTitle.textContent = "对局加载中…";
		} else {
			el.phaseTitle.textContent = `${gameDayLabel(derived.day, derived.phase)} · ${phaseLabel(derived.phase)}`;
		}
		el.statusPill.dataset.state = statusState();
		el.statusPill.textContent = statusText();

		if (!state.gameId) {
			el.connectionNote.textContent = "选择对局开始观战";
		} else if (state.status === "live") {
			el.connectionNote.textContent = "SSE 已连接 · 实时更新";
		} else if (state.status === "finished") {
			el.connectionNote.textContent = "事件流已结束 · 可拖动时间线回放";
		} else if (state.status === "error") {
			el.connectionNote.textContent = "事件流已中止";
		} else if (state.connected) {
			el.connectionNote.textContent = "已连接";
		} else {
			el.connectionNote.textContent = "正在连接事件流…";
		}
	}

	function ensureSeats() {
		if (state.seatEls.length > 0) return;
		for (let seat = 1; seat <= 9; seat++) {
			const angle = ((-90 + (seat - 1) * 40) * Math.PI) / 180;
			const x = 50 + 39 * Math.cos(angle);
			const y = 50 + 39 * Math.sin(angle);
			const root = document.createElement("div");
			root.className = "seat";
			root.dataset.seat = String(seat);
			root.style.setProperty("--x", `${x}%`);
			root.style.setProperty("--y", `${y}%`);

			const orb = document.createElement("div");
			orb.className = "seat-orb";
			const num = document.createElement("span");
			num.className = "num";
			num.textContent = String(seat);
			orb.append(num);

			const meta = document.createElement("div");
			meta.className = "seat-meta";
			const role = document.createElement("span");
			role.className = "seat-role";
			role.textContent = "身份未知";
			const status = document.createElement("span");
			status.className = "seat-status";
			status.textContent = "存活";
			meta.append(role, status);

			root.append(orb, meta);
			el.seatsRing.append(root);
			state.seatEls.push({ root, role, status });
		}
	}

	function renderSeats(derived) {
		ensureSeats();
		for (let seat = 1; seat <= 9; seat++) {
			const refs = state.seatEls[seat - 1];
			const player = derived.players.get(seat);
			const role = derived.roles.get(seat);
			const known = Boolean(role);
			const death = player ? player.death : null;
			const current = derived.currentSeat === seat && player && player.alive;

			refs.root.classList.toggle("alive", Boolean(player && player.alive));
			refs.root.classList.toggle("dead", Boolean(player && !player.alive));
			refs.root.classList.toggle("current", Boolean(current));
			refs.root.dataset.role = known ? role : "";
			refs.role.textContent = known ? roleLabel(role) : "身份未知";

			if (player && !player.alive) {
				const day = death && death.day ? `第${death.day}天` : "";
				const cause =
					state.view === "god" && death && death.causes && death.causes.length
						? ` · ${death.causes.map(causeLabel).join("/")}`
						: "";
				refs.status.textContent = `${day}出局${cause}`;
			} else if (current) {
				refs.status.textContent = "行动中…";
			} else {
				refs.status.textContent = "存活";
			}
		}
	}

	function renderCenter(derived) {
		const connected = Boolean(state.gameId);
		el.dayLabel.textContent =
			connected && derived.day !== null
				? typeof derived.phase === "string" && derived.phase.startsWith("night")
					? `第 ${derived.day} 夜`
					: `第 ${derived.day} 天`
				: "—";
		if (!connected) {
			el.phaseLabel.textContent = "等待对局";
		} else if (state.status === "error" && !derived.winner) {
			el.phaseLabel.textContent = "游戏中止";
		} else if (derived.day === null) {
			el.phaseLabel.textContent = "加载中…";
		} else {
			el.phaseLabel.textContent = phaseLabel(derived.phase);
		}
		el.aliveCount.textContent = connected ? String(derived.aliveSeats.length) : "—";
		el.deadCount.textContent = connected ? String(derived.deadSeats.length) : "—";
		if (derived.winner) {
			el.winnerLabel.hidden = false;
			el.winnerLabel.textContent = winnerLabel(derived.winner);
			el.winnerLabel.dataset.winner = derived.winner;
		} else {
			el.winnerLabel.hidden = true;
			el.winnerLabel.textContent = "";
			el.winnerLabel.dataset.winner = "";
		}
	}

	function isTimelineEvent(event) {
		if (!TIMELINE_TYPES.has(event.type)) return false;
		// judge 侧的 death 事件只用于补全死因，不在主时间线重复播报
		if (event.type === "death" && event.visibility && event.visibility.kind === "judge") {
			return false;
		}
		return true;
	}

	function createBadge(text, extraClass) {
		const badge = document.createElement("span");
		badge.className = extraClass ? `badge ${extraClass}` : "badge";
		badge.textContent = text;
		return badge;
	}

	function createTimelineEvent(event) {
		const row = document.createElement("article");
		row.className = "timeline-event";
		row.dataset.type = event.type;

		const dot = document.createElement("div");
		dot.className = "event-dot";

		const body = document.createElement("div");
		body.className = "event-body";

		const meta = document.createElement("div");
		meta.className = "event-meta";
		meta.append(createBadge(EVENT_LABELS[event.type] || event.type));
		if (event.visibility && event.visibility.kind !== "public" && state.view === "god") {
			meta.append(createBadge("私密", "private"));
		}
		if (event.actor) {
			const actor = document.createElement("span");
			actor.className = "event-actor";
			actor.textContent = `${event.actor}号`;
			meta.append(actor);
		}
		if (event.day) {
			const day = document.createElement("span");
			day.className = "event-day";
			day.textContent =
				typeof event.phase === "string" && event.phase.startsWith("night")
					? `第 ${event.day} 夜`
					: `第 ${event.day} 天`;
			meta.append(day);
		}
		body.append(meta);

		const text = document.createElement("p");
		text.className = "event-text";
		text.textContent = event.text || "";
		body.append(text);

		if (event.type === "vote_record" && event.data && event.data.votes) {
			const chips = document.createElement("div");
			chips.className = "vote-chips";
			for (const [seat, target] of Object.entries(event.data.votes)) {
				const chip = document.createElement("span");
				chip.className = "vote-chip";
				chip.textContent = `${seat}→${target === "abstain" ? "弃票" : `${target}号`}`;
				chips.append(chip);
			}
			if (chips.childElementCount > 0) body.append(chips);
		}

		row.append(dot, body);
		return row;
	}

	function createSystemEvent(event) {
		const row = document.createElement("div");
		row.className = "system-event";
		const text = document.createElement("span");
		text.className = "system-text";
		text.textContent = event.text || "";
		row.append(text);
		return row;
	}

	function renderTimeline(visible) {
		const events = visible.filter(isTimelineEvent);
		const previousScroll = el.timeline.scrollTop;
		if (events.length === 0) {
			el.timeline.replaceChildren();
			const empty = document.createElement("div");
			empty.className = "timeline-empty";
			empty.textContent = state.gameId
				? "等待事件…"
				: "选择对局后，事件会出现在这里。";
			el.timeline.append(empty);
			return;
		}

		const fragment = document.createDocumentFragment();
		let lastDay = null;
		for (const event of events) {
			if (event.day !== lastDay) {
				lastDay = event.day;
				const divider = document.createElement("div");
				divider.className = "day-divider";
				divider.textContent = `第 ${event.day} 天`;
				fragment.append(divider);
			}
			if (SYSTEM_TYPES.has(event.type)) {
				fragment.append(createSystemEvent(event));
			} else {
				fragment.append(createTimelineEvent(event));
			}
		}
		el.timeline.replaceChildren(fragment);
		if (state.follow || state.replayTimer) {
			el.timeline.scrollTop = el.timeline.scrollHeight;
		} else {
			el.timeline.scrollTop = previousScroll;
		}
	}

	function addGodBlock(parent, title, text) {
		const block = document.createElement("div");
		block.className = "god-block";
		const heading = document.createElement("h4");
		heading.textContent = title;
		const content = document.createElement("p");
		content.textContent = text;
		block.append(heading, content);
		parent.append(block);
	}

	function renderGodPanel(visible, derived) {
		const show = state.view === "god" && state.config.godEnabled === true;
		el.godPanel.hidden = !show;
		if (!show) {
			el.godContent.replaceChildren();
			return;
		}

		const grid = document.createElement("div");
		grid.className = "god-grid";

		const groups = { werewolf: [], seer: [], witch: [], hunter: [], villager: [] };
		for (const [seat, role] of derived.roles) {
			if (!groups[role]) groups[role] = [];
			groups[role].push(seat);
		}
		const describe = (seats) =>
			seats.length === 0
				? "无"
				: seats
						.map((seat) => {
							const player = derived.players.get(seat);
							return `${seat}号${player && !player.alive ? "（出局）" : ""}`;
						})
						.join("、");

		if (derived.roles.size === 0) {
			addGodBlock(
				grid,
				"身份",
				"暂无身份数据。旧日志可能缺少 role_assigned；游戏结束后可从 game_end 读取。",
			);
		} else {
			addGodBlock(grid, "狼队", describe(groups.werewolf));
			const gods = [...groups.seer, ...groups.witch, ...groups.hunter];
			addGodBlock(
				grid,
				"神职",
				gods.length === 0
					? "无"
					: gods
							.map((seat) => {
								const player = derived.players.get(seat);
								return `${seat}号${roleLabel(derived.roles.get(seat))}${player && !player.alive ? "（出局）" : ""}`;
							})
							.join("、"),
			);
			addGodBlock(grid, "村民", describe(groups.villager));
		}

		const seerResults = visible.filter((event) => event.type === "seer_result").slice(-6);
		if (seerResults.length > 0) {
			addGodBlock(
				grid,
				"查验记录",
				seerResults
					.map((event) => `${event.actor ? `${event.actor}号：` : ""}${event.text}`)
					.join("\n"),
			);
		}

		const witchActions = visible.filter((event) => event.type === "witch_action").slice(-6);
		if (witchActions.length > 0) {
			addGodBlock(
				grid,
				"女巫用药",
				witchActions
					.map((event) => `${event.actor ? `${event.actor}号：` : ""}${event.text}`)
					.join("\n"),
			);
		}

		const wolfChat = visible.filter((event) => event.type === "wolf_speech").slice(-6);
		if (wolfChat.length > 0) {
			addGodBlock(
				grid,
				"狼队频道",
				wolfChat
					.map((event) => `${event.actor ? `${event.actor}号：` : ""}${event.text}`)
					.join("\n"),
			);
		}

		const issues = visible.filter((event) => ISSUE_TYPES.has(event.type));
		if (issues.length > 0) {
			const counts = {};
			for (const event of issues) counts[event.type] = (counts[event.type] || 0) + 1;
			const text = Object.entries(counts)
				.map(([type, count]) => `${EVENT_LABELS[type] || type}: ${count}`)
				.join("；");
			addGodBlock(grid, "法官异常", text);
		}

		el.godContent.replaceChildren(grid);
	}

	function renderControls() {
		const max = Math.max(0, state.events.length);
		const cursor = Math.min(Math.max(0, state.cursor), max);
		el.scrubber.max = String(max);
		el.scrubber.value = String(cursor);
		el.scrubber.disabled = max === 0;
		el.scrubberLabel.textContent = `事件 ${cursor} / ${max}`;
		el.followLabel.textContent = state.follow ? "跟随最新" : "回放中";
		el.latestBtn.hidden = state.follow || cursor >= max || max === 0;
		el.replayBtn.hidden = state.status !== "finished" || max < 2;
		el.replayBtn.textContent = state.replayTimer ? "暂停回放" : "自动回放";
	}

	// ------------------------------------------------------------------
	// 交互
	// ------------------------------------------------------------------

	function stopReplay() {
		if (state.replayTimer) {
			clearInterval(state.replayTimer);
			state.replayTimer = null;
		}
	}

	function toggleReplay() {
		if (state.replayTimer) {
			stopReplay();
			state.follow = state.cursor >= state.events.length;
			scheduleRender();
			return;
		}
		if (state.events.length < 2) return;
		if (state.cursor >= state.events.length) state.cursor = 0;
		state.follow = false;
		state.replayTimer = setInterval(() => {
			if (state.cursor >= state.events.length) {
				stopReplay();
				state.follow = true;
				scheduleRender();
				return;
			}
			state.cursor += 1;
			if (state.cursor >= state.events.length) {
				stopReplay();
				state.follow = true;
			}
			scheduleRender();
		}, 650);
		scheduleRender();
	}

	async function startGame(event) {
		event.preventDefault();
		state.formError = null;
		hideError();
		const mode = el.modeSelect.value === "live" ? "live" : "scripted";
		const seed = el.seedInput.value.trim() || randomSeed();
		const model = mode === "live" ? el.modelSelect.value : undefined;
		el.startGameBtn.disabled = true;
		el.startGameBtn.textContent = "启动中…";
		el.newGameHint.classList.remove("error");
		el.newGameHint.textContent = "正在创建对局…";
		try {
			const result = await fetchJson("/api/games", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mode, seed, model }),
			});
			el.newGamePanel.hidden = true;
			el.seedInput.value = randomSeed();
			await loadGames();
			await refreshConfig();
			selectGame(result.gameId);
			state.status = "connecting";
			scheduleRender();
		} catch (error) {
			state.formError = error.message;
			showError(`启动对局失败：${error.message}`);
		} finally {
			el.startGameBtn.textContent = "开始对局";
			updateStartState();
			if (state.formError) {
				el.newGameHint.textContent = state.formError;
				el.newGameHint.classList.add("error");
			}
		}
	}

	function bindEvents() {
		el.gameSelect.addEventListener("change", () => {
			const gameId = el.gameSelect.value;
			if (gameId && gameId !== state.gameId) {
				state.gameId = gameId;
				connect(gameId);
			}
		});

		for (const button of el.viewToggle.querySelectorAll("button[data-view]")) {
			button.addEventListener("click", () => {
				const view = button.dataset.view;
				if (view !== "public" && view !== "god") return;
				if (view === state.view) return;
				if (view === "god" && !state.config.godEnabled) return;
				state.view = view;
				updateViewToggle();
				if (state.gameId) connect(state.gameId);
			});
		}

		el.refreshBtn.addEventListener("click", async () => {
			await loadGames();
			await refreshConfig();
			if (!state.gameId && state.games[0]) {
				selectGame(state.games[0].gameId);
			}
		});

		el.newGameBtn.addEventListener("click", () => {
			el.newGamePanel.hidden = !el.newGamePanel.hidden;
			if (!el.newGamePanel.hidden) {
				el.seedInput.focus();
				el.seedInput.select();
			}
		});

		el.modeSelect.addEventListener("change", updateModelField);
		el.modelSelect.addEventListener("change", updateStartState);
		el.newGameForm.addEventListener("submit", startGame);
		el.errorClose.addEventListener("click", hideError);

		el.scrubber.addEventListener("input", () => {
			stopReplay();
			const cursor = Number(el.scrubber.value);
			state.cursor = Math.min(Math.max(0, cursor), state.events.length);
			state.follow = state.cursor >= state.events.length;
			scheduleRender();
		});

		el.latestBtn.addEventListener("click", () => {
			stopReplay();
			state.follow = true;
			state.cursor = state.events.length;
			scheduleRender();
		});

		el.replayBtn.addEventListener("click", toggleReplay);

		el.timeline.addEventListener("scroll", () => {
			if (!state.follow) return;
			const nearBottom =
				el.timeline.scrollHeight - el.timeline.clientHeight - el.timeline.scrollTop < 56;
			if (!nearBottom) {
				state.follow = false;
				renderControls();
			}
		});

		window.addEventListener("beforeunload", closeStream);
	}

	async function init() {
		el.seedInput.value = randomSeed();
		bindEvents();
		await Promise.all([refreshConfig(), loadGames()]);
		if (state.games.length > 0) {
			selectGame(state.games[0].gameId);
		} else {
			el.newGamePanel.hidden = false;
			scheduleRender();
		}
	}

	void init();
})();
