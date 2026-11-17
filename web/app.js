const el = Object.fromEntries([...document.querySelectorAll("[id]")].map((node) => [node.id, node]));
const ROLE = { werewolf: "狼人", villager: "村民", seer: "预言家", witch: "女巫", hunter: "猎人", idiot: "白痴" };
const PHASE = {
	setup: "准备", night_wolves: "狼人行动", night_seer: "预言家查验", night_witch: "女巫用药",
	dawn: "天亮", sheriff_signup: "警长报名", sheriff_speech: "竞选发言", sheriff_vote: "警长投票",
	badge_transfer: "警徽移交", day_discuss: "白天讨论", day_vote: "放逐投票",
	last_words: "遗言", hunter_shot: "猎人开枪", ended: "游戏结束",
};
const EVENT = {
	game_start: "开局", role_assigned: "身份", phase: "阶段", speech: "发言", last_words: "遗言",
	wolf_speech: "狼队发言", wolf_vote: "狼队投票", wolf_target: "狼刀", wolf_plan: "狼队战术",
	seer_result: "查验", witch_info: "刀口", witch_action: "用药", vote_cast: "投票",
	vote_record: "放逐投票", death: "死亡", hunter_shot: "开枪", sheriff_signup: "上警",
	sheriff_speech: "竞选发言", sheriff_vote: "警长投票", sheriff_elected: "警长结果",
	badge_transfer: "警徽移交", idiot_revealed: "白痴翻牌", game_end: "终局",
	agent_error: "玩家错误", model_retry: "模型重试", default_action: "保底动作", model_roster: "模型分配",
	action_rejected: "规则拒绝", turn_start: "轮到玩家",
};
const TURN = {
	wolf_strategy: "狼队战术", wolf_turn: "狼队行动", seer_check: "查验", witch_act: "用药",
	sheriff_signup: "上警", sheriff_speech: "竞选发言", sheriff_vote: "警长投票",
	badge_transfer: "警徽移交", hunter_shoot: "开枪", last_words: "遗言", day_speech: "发言", day_vote: "放逐投票",
};
const CAUSE = { wolf_kill: "狼刀", poison: "毒杀", exile: "放逐", hunter_shot: "枪杀" };
const WINNER = { good: "好人阵营获胜", wolf: "狼人阵营获胜" };
const SPEECH = new Set(["speech", "last_words", "sheriff_speech", "wolf_speech", "wolf_plan"]);
const VOTE = new Set(["sheriff_signup", "sheriff_vote", "sheriff_elected", "badge_transfer", "vote_cast", "vote_record"]);
const KEY = new Set(["game_start", "death", "hunter_shot", "idiot_revealed", "game_end"]);
const ISSUES = new Set(["model_retry", "agent_error", "action_rejected", "default_action"]);
const NOT_HEADLINE = new Set(["role_assigned", "model_roster", "turn_start", "vote_cast", "witch_info", ...ISSUES]);
const INTEL = {
	roles: "身份与阵营", plan: "狼队战术", wolves: "狼队行动", seer: "预言家查验",
	witch: "女巫用药", votes: "警徽与放逐", judge: "异常与重试",
};

const state = {
	config: {}, games: [], id: null, view: "public", status: "idle",
	events: [], cursor: 0, following: true, source: null, turn: null, roster: [], mode: null,
	pane: "live", detail: null, historyPage: 0, replay: null,
	readKey: null, bodyText: "", pages: [""], readPage: 0, readSize: "",
	seatButtons: [], seatDetail: null, pendingRender: false, choosing: false, initializedConfig: false,
};

function node(tag, className, text) {
	const element = document.createElement(tag);
	if (className) element.className = className;
	if (text !== undefined) element.textContent = text;
	return element;
}

function write(id, value) {
	const target = el[id];
	if (target.textContent !== String(value)) target.textContent = value;
}

function option(select, value, label) {
	const item = node("option", "", label);
	item.value = value;
	select.append(item);
	return item;
}

function showError(message) {
	write("error-text", message);
	el["error-banner"].hidden = false;
}
function hideError() {
	el["error-banner"].hidden = true;
}

async function request(path, options) {
	const response = await fetch(path, options);
	const data = await response.json();
	if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
	return data;
}

function randomSeed() {
	return Math.random().toString(36).slice(2, 10);
}

function dayLabel(day, phase) {
	return `第 ${day} ${phase?.startsWith("night") ? "夜" : "天"}`;
}

function phaseLabel(phase) {
	return state.view === "public" && phase?.startsWith("night") ? "夜间行动" : PHASE[phase] ?? "准备";
}

function queueRender() {
	if (state.pendingRender) return;
	state.pendingRender = true;
	requestAnimationFrame(() => {
		state.pendingRender = false;
		render();
	});
}

async function loadConfig() {
	try {
		state.config = await request("/api/config");
		const { godEnabled, models = [], modelLabels = {}, modelSets = [], defaultModel, defaultBoard } = state.config;
		const select = el["model-select"];
		const old = select.value;
		select.replaceChildren();
		for (const model of models) option(select, model, modelLabels[model] ?? model);
		for (const set of modelSets) option(select, set.id, set.label);
		const values = new Set([...select.options].map((item) => item.value));
		if (values.size === 0) option(select, "", "无可用模型");
		select.value = values.has(old) ? old : values.has(defaultModel) ? defaultModel : select.options[0].value;
		select.disabled = values.size === 0;
		el["mode-select"].options[1].disabled = values.size === 0;
		if (!state.initializedConfig) {
			state.initializedConfig = true;
			el["board-select"].value = defaultBoard === "12p" ? "12p" : "9p";
			el["mode-select"].value = values.size ? "live" : "scripted";
		}
		if (values.size === 0) el["mode-select"].value = "scripted";
		if (!godEnabled && state.view === "god") {
			state.view = "public";
			if (state.id) connect(state.id);
		}
		el["view-toggle"].hidden = !godEnabled;
		updateForm();
		queueRender();
	} catch (error) {
		showError(`读取配置失败：${error.message}`);
	}
}

async function loadGames() {
	try {
		const data = await request("/api/games");
		state.games = data.games;
		const select = el["game-select"];
		select.replaceChildren();
		for (const game of data.games) {
			const label = game.seed || game.gameId;
			const board = game.playerCount ? ` · ${game.playerCount} 人` : "";
			const status = WINNER[game.winner] || { finished: "已结束", running: "进行中", error: "已中止" }[game.status];
			const item = option(select, game.gameId, `${label}${board}${status ? ` · ${status}` : ""}`);
			item.title = game.gameId;
		}
		if (!data.games.length) option(select, "", "暂无对局");
		select.disabled = !data.games.length;
		if (state.id && data.games.some((game) => game.gameId === state.id)) select.value = state.id;
	} catch (error) {
		showError(`读取对局列表失败：${error.message}`);
	}
}

function closeSource() {
	state.source?.close();
	state.source = null;
}

function connect(id) {
	closeSource();
	stopReplay();
	state.id = id;
	state.status = "connecting";
	state.events = [];
	state.cursor = 0;
	state.following = true;
	state.turn = null;
	state.roster = [];
	state.mode = null;
	state.detail = null;
	state.historyPage = 0;
	state.readKey = null;
	state.pane = "live";
	state.seatDetail = null;
	el["history-filter"].value = "all";
	el["history-day"].value = "";
	el["history-items"].replaceChildren();
	delete el["history-items"].dataset.events;
	el["seat-detail"].replaceChildren();
	delete el["seat-detail"].dataset.key;
	el["seat-dialog"].close();
	el["reader-dialog"].close();
	restoreReader(false);
	el["game-select"].value = id;
	hideError();
	render();

	const source = new EventSource(`/api/games/${encodeURIComponent(id)}/events?view=${state.view}`);
	state.source = source;
	const listen = (name, handle) => source.addEventListener(name, (message) => {
		if (state.source !== source) return;
		let data;
		try {
			data = JSON.parse(message.data);
		} catch {
			return;
		}
		handle(data);
		queueRender();
	});
	source.addEventListener("open", () => {
		if (state.source !== source) return;
		state.status = "live";
		queueRender();
	});
	listen("roster", (message) => {
		if (message.gameId !== id) return;
		state.roster = message.players;
		state.mode = message.mode;
	});
	listen("game", (event) => {
		if (event.gameId !== id || !Number.isInteger(event.seq) || event.seq <= (state.events.at(-1)?.seq ?? 0)) return;
		state.events.push(event);
		if (state.following) state.cursor = state.events.length;
	});
	listen("turn", (message) => {
		if (message.gameId === id) state.turn = message.turn;
	});
	listen("server_error", (message) => showError(message.message || "对局中止"));
	listen("done", (message) => {
		state.status = message.state === "error" ? "error" : "finished";
		state.turn = null;
		closeSource();
		void Promise.all([loadGames(), loadConfig()]);
	});
	source.addEventListener("error", () => {
		if (state.source !== source) return;
		state.turn = null;
		state.status = source.readyState === EventSource.CLOSED ? "error" : "connecting";
		if (state.status === "error") showError("未能读取此对局，请刷新列表后重试。");
		queueRender();
	});
}

function derive(events) {
	const setup = events[0]?.type === "game_start" ? events[0].data : null;
	const known = state.games.find((game) => game.gameId === state.id);
	const count = (setup?.playerCount ?? known?.playerCount ?? state.roster.length) === 12 ? 12 : 9;
	const players = Array.from({ length: count }, (_, index) => ({
		seat: index + 1, role: null, deathDay: null, causes: new Set(), revealed: false, candidate: false,
	}));
	const player = (seat) => Number.isInteger(seat) ? players[seat - 1] : null;
	const death = (seat, day, causes) => {
		const target = player(seat);
		if (!target) return;
		target.deathDay ??= day;
		for (const cause of causes ?? []) target.causes.add(cause);
	};
	let sheriff = null;
	let winner = null;
	let electionEnded = false;
	for (const event of events) {
		const data = event.data ?? {};
		const actor = player(event.actor);
		switch (event.type) {
			case "role_assigned":
				if (actor && ROLE[data.role]) actor.role = data.role;
				break;
			case "death":
				for (const seat of data.seats ?? []) death(seat, event.day);
				for (const item of data.deaths ?? []) death(item.seat, event.day, item.causes);
				if (data.seat) death(data.seat, event.day, data.causes);
				break;
			case "vote_record":
				if (data.exiled && !data.idiotRevealed) death(data.exiled, event.day, ["exile"]);
				break;
			case "hunter_shot":
				if (event.target) death(event.target, event.day, ["hunter_shot"]);
				break;
			case "idiot_revealed":
				if (actor) { actor.revealed = true; actor.role = "idiot"; }
				break;
			case "sheriff_signup":
				if (actor) actor.candidate = data.run === true;
				break;
			case "sheriff_elected":
				electionEnded = true;
				sheriff = data.seat ?? null;
				break;
			case "badge_transfer":
				sheriff = data.to ?? null;
				break;
			case "game_end":
				winner = data.winner;
				for (const [seat, role] of Object.entries(data.roles ?? {})) {
					const target = player(Number(seat));
					if (target && ROLE[role]) target.role = role;
				}
				break;
		}
	}
	const turn = state.following && state.status === "live" ? state.turn : null;
	const last = turn ?? events.at(-1);
	return {
		players, count, sheriff, winner, turn,
		day: last?.day,
		phase: last?.phase ?? "setup",
		alive: players.filter((p) => p.deathDay === null).length,
		electionEnded,
	};
}

function renderMatch(match) {
	const { winner, day, phase, count, alive, sheriff, players, electionEnded } = match;
	const viewingPast = !state.following || state.replay !== null;
	const effective = viewingPast ? "replay" : state.status;
	el["status-pill"].dataset.state = effective;
	write("status-pill", { replay: "回放", live: "直播", connecting: "连接中", finished: "已结束", error: "已中止", idle: "待开局" }[effective]);
	write("game-id", state.id ?? "MATCH DESK");
	el["game-id"].title = state.id ?? "";
	write("phase-title", WINNER[winner] ?? (phase === "ended" ? "结束 · 未分胜负" : day ? `${dayLabel(day, phase)} · ${phaseLabel(phase)}` : state.id ? "载入对局…" : "等待对局"));
	write("alive-count", day ? String(alive).padStart(2, "0") : "—");
	write("dead-count", day ? String(count - alive).padStart(2, "0") : "—");
	const candidates = players.filter((player) => player.candidate).length;
	write("sheriff-label", count === 9 || !day ? "—" : sheriff !== null ? `${sheriff} 号` : !electionEnded && candidates ? `${candidates} 人上警` : "暂无");
	write("board-label", `${count} 人局`);
	write("connection-note", effective === "replay" ? "在查看某一刻 · 可随时回到最新" : effective === "live"
		? `实时连接 · ${state.view === "god" ? "上帝视角" : "公开视角"}`
		: { connecting: "正在连接对局", finished: "完整记录 · 可按事件回放", error: "对局已中止 · 可查看已有记录", idle: "等待选择对局" }[effective]);
	for (const button of el["view-toggle"].querySelectorAll("button")) {
		button.setAttribute("aria-pressed", String(button.dataset.view === state.view));
	}
}

function modelFor(seat) {
	return state.roster[seat - 1]?.model ?? null;
}

function icon(container, model, fallback) {
	const mark = typeof model?.logo === "string" && /^\/models\/[a-z]+\.svg$/.test(model.logo) ? model.logo : null;
	const key = mark ?? fallback;
	if (container.dataset.icon === key) return;
	container.dataset.icon = key;
	if (mark) {
		const image = node("img");
		image.alt = "";
		image.width = 22;
		image.height = 22;
		image.addEventListener("error", () => {
			if (container.dataset.icon === key) container.textContent = fallback;
		}, { once: true });
		image.src = mark;
		container.replaceChildren(image);
	} else {
		container.textContent = fallback;
	}
}

function ensureSeatButtons(count) {
	if (state.seatButtons.length === count) return;
	el["seat-grid"].replaceChildren();
	el["seat-grid"].dataset.count = count;
	state.seatButtons = Array.from({ length: count }, (_, index) => {
		const seat = index + 1;
		const button = node("button", "seat");
		button.type = "button";
		const header = node("span", "seat-head");
		const number = node("span", "seat-number", String(seat).padStart(2, "0"));
		const badge = node("span", "seat-badge");
		const logo = node("span", "model-icon");
		logo.setAttribute("aria-hidden", "true");
		header.append(number, badge, logo);
		const info = node("span", "seat-info");
		const model = node("span", "seat-model");
		const detail = node("span", "seat-detail");
		info.append(model, detail);
		button.append(header, info);
		button.addEventListener("click", () => {
			state.seatDetail = seat;
			renderSeatDialog(derive(state.events.slice(0, state.cursor)));
			el["seat-dialog"].showModal();
		});
		el["seat-grid"].append(button);
		return { button, model, detail, badge, logo };
	});
}

function seatState(player, match) {
	const active = match.turn?.seat === player.seat;
	if (active) {
		if (match.turn.progress.state === "retrying") return "重试中";
		return player.deathDay === null ? "行动中" : TURN[match.turn.kind];
	}
	if (player.deathDay !== null) return `第${player.deathDay}天出局`;
	if (player.revealed) return "翻牌 · 无票";
	if (!match.electionEnded && player.candidate) return "警上";
	return match.day ? "存活" : "待入席";
}

function renderRoster(match) {
	ensureSeatButtons(match.count);
	for (const player of match.players) {
		const refs = state.seatButtons[player.seat - 1];
		const model = modelFor(player.seat);
		const status = seatState(player, match);
		const role = ROLE[player.role] ?? "";
		const sheriff = player.seat === match.sheriff;
		const name = model?.label ?? (state.mode === "scripted" ? "脚本玩家" : match.day ? "模型未记录" : "待配对");
		refs.button.dataset.role = player.role ?? "";
		refs.button.dataset.status = match.turn?.seat === player.seat ? "current" : player.deathDay === null ? "alive" : "dead";
		refs.button.dataset.sheriff = String(sheriff);
		refs.model.textContent = name;
		refs.detail.textContent = [role, status].filter(Boolean).join(" · ");
		refs.badge.textContent = sheriff ? "警" : "";
		refs.badge.hidden = !sheriff;
		const label = `${player.seat} 号，${name}，${refs.detail.textContent}${sheriff ? "，持有警徽" : ""}`;
		refs.button.setAttribute("aria-label", label);
		refs.button.title = label;
		icon(refs.logo, model, state.mode === "scripted" ? "◇" : "·");
	}
	const models = new Set(state.roster.map((item) => item.model?.spec).filter(Boolean));
	write("roster-note", state.mode === "scripted" ? "脚本对局" : models.size > 0 ? `${models.size} 款模型 · 按座位分配` : match.day ? "未记录模型分配" : "选择对局后显示玩家");
	if (el["seat-dialog"].open) renderSeatDialog(match);
}

function renderSeatDialog(match) {
	const player = match.players[state.seatDetail - 1];
	if (!player) return;
	write("seat-detail-title", `${player.seat} 号玩家`);
	const model = modelFor(player.seat);
	const rows = [
		["模型", model?.spec ?? (state.mode === "scripted" ? "脚本玩家" : "未记录")],
		["身份", ROLE[player.role] ?? "尚未公开"],
		["状态", seatState(player, match)],
	];
	if (match.sheriff === player.seat) rows.push(["警徽", player.revealed || player.deathDay !== null ? "当前无法投票" : "放逐时 1.5 票"]);
	if (player.causes.size > 0) rows.push(["出局原因", [...player.causes].map((cause) => CAUSE[cause] ?? cause).join("、")]);
	const detail = el["seat-detail"];
	const key = JSON.stringify(rows);
	if (detail.dataset.key === key) return;
	detail.dataset.key = key;
	const list = node("dl", "player-facts");
	for (const [label, value] of rows) {
		const div = node("div");
		div.append(node("dt", "", label), node("dd", "", value));
		list.append(div);
	}
	detail.replaceChildren(list);
}

function eventText(event) {
	let text = event.text ?? "";
	const votes = Object.entries(event.data?.votes ?? {});
	if (event.type === "sheriff_elected" && votes.length) {
		text += `\n\n票型：${votes.map(([seat, target]) => `${seat} → ${target === "abstain" ? "弃票" : `${target} 号`}`).join("、")}`;
	}
	return text;
}

function eventCard(event) {
	return {
		key: `event-${event.seq}`,
		seat: event.actor,
		title: event.actor ? `${event.actor} 号 · ${EVENT[event.type] ?? event.type}` : EVENT[event.type] ?? "法官播报",
		meta: `${dayLabel(event.day, event.phase)} · #${event.seq}`,
		badge: event.visibility?.kind === "public" ? (SPEECH.has(event.type) ? "已确认" : "") : "私密",
		text: eventText(event),
	};
}

function liveCard(events, match) {
	const turn = match.turn;
	if (turn) {
		const { progress } = turn;
		const name = TURN[turn.kind] ?? "行动";
		const retry = progress.state === "retrying" ? progress.retry : null;
		const text = retry ? `模型请求暂时失败，约 ${(retry.delayMs / 1000).toFixed(1)} 秒后进行第 ${retry.attempt} 次重试。`
			: progress.state === "streaming" ? progress.text
			: turn.visibility === "public" ? "等待玩家组织发言…" : "等待玩家提交行动…";
		return {
			key: `turn-${turn.id}-${progress.state}`, seat: turn.seat,
			title: `${turn.seat} 号 · ${name}`,
			meta: turn.visibility === "public" ? dayLabel(turn.day, turn.phase) : `${dayLabel(turn.day, turn.phase)} · 私密`,
			badge: retry ? "正在重试" : progress.state === "streaming" ? "实时草稿" : "等待输出",
			live: progress.state === "streaming", text,
		};
	}
	const event = !state.following ? events.at(-1) : events.findLast((item) => !NOT_HEADLINE.has(item.type) &&
		!(item.type === "death" && item.visibility?.kind === "judge"));
	if (event) return eventCard(event);
	return {
		key: "empty", title: state.id ? "等待事件" : "今晚，谁在说谎？", meta: "对局播报",
		text: state.id ? "新的发言和判决会在这里出现。" : "从顶部选择一局回放，也可以新建 9 人或 12 人对局。",
	};
}

function intelCard(events, match) {
	const kind = el["intel-select"].value;
	const group = {
		plan: ["wolf_plan"], wolves: ["wolf_speech", "wolf_vote", "wolf_target"],
		seer: ["seer_result"], witch: ["witch_info", "witch_action"],
		votes: ["sheriff_elected", "badge_transfer", "vote_record"], judge: [...ISSUES],
	}[kind];
	let text;
	if (kind === "roles") {
		text = Object.entries(ROLE).map(([role, label]) => {
			const seats = match.players.filter((p) => p.role === role);
			return seats.length ? `${label}：${seats.map((p) => `${p.seat} 号${p.deathDay !== null ? "（出局）" : p.revealed ? "（翻牌）" : ""}`).join("、")}` : "";
		}).filter(Boolean).join("\n");
	} else if (group) {
		text = events.filter((event) => group.includes(event.type)).reverse().map((event) => {
			const who = event.actor ? ` · ${event.actor} 号` : "";
			const label = [kind === "wolves" || kind === "votes" || kind === "judge" ? EVENT[event.type] : "", dayLabel(event.day, event.phase)].filter(Boolean).join(" · ");
			return `${label}${who}：${eventText(event)}`;
		}).join("\n\n");
	}
	return { key: `intel-${kind}`, title: INTEL[kind], meta: "上帝视角", badge: "私密", text: text || "暂无记录。" };
}

const segmenter = new Intl.Segmenter("zh", { granularity: "grapheme" });

/** 用真实行高测量分页，保留每个字，适应中英文混排、换行及窗口缩放。 */
function paginate(text, width, height) {
	if (!text || width <= 0 || height <= 0) return [text];
	const measure = el["reader-measure"];
	const fits = (value) => {
		measure.textContent = value;
		return measure.getBoundingClientRect().height <= height;
	};
	try {
		if (text.length <= 1000 && fits(text)) return [text];
		const points = [...segmenter.segment(text)].map(({ index }) => index);
		points.push(text.length);
		const pages = [];
		for (let start = 0; start < points.length - 1;) {
			const valueAt = (end) => text.slice(points[start], points[end]);
			let end = Math.min(start + 64, points.length - 1);
			let low = start + 1;
			while (fits(valueAt(end))) {
				low = end;
				if (end === points.length - 1) break;
				end = Math.min(start + (end - start) * 2, points.length - 1);
			}
			let high = end;
			while (low < high) {
				const mid = Math.floor((low + high + 1) / 2);
				if (fits(valueAt(mid))) low = mid;
				else high = mid - 1;
			}
			pages.push(valueAt(low));
			start = low;
		}
		return pages.length ? pages : [text];
	} finally {
		measure.textContent = "";
	}
}

function renderReader(card) {
	write("reader-title", card.title);
	write("reader-meta", card.meta);
	write("reader-state", card.badge ?? "");
	el["reader-state"].hidden = !card.badge;
	el.reader.dataset.live = String(Boolean(card.live));
	el.reader.dataset.empty = String(card.key === "empty");
	icon(el["speaker-mark"], modelFor(card.seat), card.seat ? String(card.seat).padStart(2, "0") : "◆");
	const width = el["reader-content"].clientWidth;
	const padding = getComputedStyle(el["reader-content"]);
	const height = el["reader-content"].clientHeight - parseFloat(padding.paddingTop) - parseFloat(padding.paddingBottom);
	const size = `${width}×${height}`;
	if (state.readKey !== card.key || state.bodyText !== card.text || state.readSize !== size) {
		const same = state.readKey === card.key;
		const tail = card.live && state.readPage === state.pages.length - 1;
		const offset = state.pages.slice(0, state.readPage).reduce((sum, page) => sum + page.length, 0);
		state.pages = paginate(card.text, width, height);
		if (!same) {
			state.readPage = 0;
		} else if (tail) {
			state.readPage = state.pages.length - 1;
		} else {
			let length = 0;
			const nextPage = state.pages.findIndex((page) => (length += page.length) > offset);
			state.readPage = nextPage === -1 ? state.pages.length - 1 : nextPage;
		}
		state.readKey = card.key;
		state.bodyText = card.text;
		state.readSize = size;
	}
	write("reader-text", state.pages[state.readPage]);
	el["reader-pager"].hidden = state.pages.length < 2;
	const expanded = el["reader-dialog"].open;
	el["reader-expand"].hidden = !expanded && state.pages.length < 2;
	write("reader-expand", expanded ? "收起" : "全文");
	write("reader-page", `${state.readPage + 1} / ${state.pages.length}`);
	el["reader-prev"].disabled = state.readPage <= 0;
	el["reader-next"].disabled = state.readPage >= state.pages.length - 1;
}

function passesFilter(event, filter) {
	if (filter === "speech") return SPEECH.has(event.type);
	if (filter === "vote") return VOTE.has(event.type);
	if (filter === "key") return KEY.has(event.type);
	if (filter === "private") return event.visibility?.kind !== "public";
	return true;
}

function renderHistory() {
	const filter = el["history-filter"].value;
	const days = [...new Set(state.events.map((event) => event.day))].sort((a, b) => a - b);
	const select = el["history-day"];
	const selectedDay = select.value;
	const dayKey = days.join(",");
	if (select.dataset.days !== dayKey) {
		select.dataset.days = dayKey;
		select.replaceChildren();
		option(select, "", "全部天数");
		for (const day of days) option(select, day, `第 ${day} 天`);
		select.value = days.map(String).includes(selectedDay) ? selectedDay : "";
	}
	const all = state.events.filter((event) => (!select.value || String(event.day) === select.value) && passesFilter(event, filter));
	const items = el["history-items"];
	const css = getComputedStyle(items);
	const row = parseFloat(css.getPropertyValue("--history-row")) || 45;
	const gap = parseFloat(css.rowGap) || 0;
	const pageSize = Math.max(1, Math.floor((items.clientHeight + gap) / (row + gap)));
	const pageCount = Math.max(1, Math.ceil(all.length / pageSize));
	state.historyPage = Math.min(pageCount - 1, state.historyPage);
	const selected = all.slice().reverse().slice(state.historyPage * pageSize, (state.historyPage + 1) * pageSize);
	const key = selected.map(({ seq }) => seq).join(",");
	if (items.dataset.events !== key) {
		items.dataset.events = key;
		items.replaceChildren();
		if (!selected.length) items.append(node("p", "empty-history", "这里还没有事件。"));
		for (const event of selected) {
			const button = node("button", "history-item");
			button.type = "button";
			button.dataset.seq = event.seq;
			const day = node("span", "history-day", `D${String(event.day).padStart(2, "0")}`);
			const label = node("span", "history-type", EVENT[event.type] ?? event.type);
			const description = node("span", "history-text", `${event.actor ? `${event.actor} 号 · ` : ""}${event.text}`);
			const arrow = node("span", "history-arrow", "›");
			arrow.setAttribute("aria-hidden", "true");
			button.append(day, label, description, arrow);
			button.addEventListener("click", () => {
				state.detail = event;
				queueRender();
				requestAnimationFrame(() => el["detail-back"].focus());
			});
			items.append(button);
		}
	}
	write("history-count", `${all.length} 条`);
	write("history-page", `${state.historyPage + 1} / ${pageCount}`);
	el["history-prev"].disabled = state.historyPage === 0;
	el["history-next"].disabled = state.historyPage >= pageCount - 1;
}

function renderFeed(events, match) {
	const god = state.view === "god";
	const history = state.pane === "history" && !state.detail;
	const intel = state.pane === "intel" && god;
	for (const button of el["feed-tabs"].querySelectorAll("button")) {
		const name = button.dataset.pane;
		button.hidden = name === "intel" && !god;
		button.setAttribute("aria-pressed", String(name === state.pane));
	}
	el["history-filter"].options[4].hidden = !god;
	el.history.hidden = !history;
	el.reader.hidden = history;
	el["intel-picker"].hidden = !intel;
	el["detail-back"].hidden = !state.detail;
	el["detail-jump"].hidden = !state.detail;
	if (history) renderHistory();
	else renderReader(state.detail ? eventCard(state.detail) : intel ? intelCard(events, match) : liveCard(events, match));
}

function renderReplay() {
	const count = state.events.length;
	el.scrubber.max = count;
	el.scrubber.value = state.cursor;
	el.scrubber.disabled = count === 0;
	write("scrubber-label", `事件 ${state.cursor} / ${count}`);
	write("follow-label", state.following ? "跟随最新" : "回放定位");
	const ready = count > 1 && state.status === "finished";
	el["replay-btn"].disabled = !ready;
	const action = state.replay !== null ? "暂停回放" : "自动回放";
	el["replay-btn"].setAttribute("aria-label", action);
	el["replay-btn"].title = action;
	write("replay-btn", state.replay !== null ? "Ⅱ" : "▶");
	const canPause = state.status === "live" && count > 0;
	el["latest-btn"].disabled = state.following && !canPause;
	write("latest-btn", state.following && canPause ? "定格" : "最新");
}

function render() {
	const events = state.events.slice(0, state.cursor);
	const match = derive(events);
	renderMatch(match);
	renderRoster(match);
	renderFeed(events, match);
	renderReplay();
}

function updateForm() {
	const live = el["mode-select"].value === "live";
	const busy = state.choosing || state.config.starting || state.config.activeGameId;
	el["model-field"].hidden = !live;
	el["start-game-btn"].disabled = Boolean(busy) || (live && !el["model-select"].value);
	write("start-game-btn", state.choosing ? "正在开启…" : "开始对局");
	const hint = busy ? "同一时间只能开启一局。" : live
		? "真实模型逐个行动，会使用已配置账户的模型额度。"
		: "脚本玩家无需调用模型，适合快速试一局。";
	if (!el["new-game-hint"].classList.contains("error")) write("new-game-hint", hint);
}

async function startGame(event) {
	event.preventDefault();
	if (state.choosing) return;
	state.choosing = true;
	el["new-game-hint"].classList.remove("error");
	updateForm();
	const mode = el["mode-select"].value;
	try {
		const data = await request("/api/games", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				seed: el["seed-input"].value.trim() || randomSeed(),
				board: el["board-select"].value,
				mode,
				model: mode === "live" ? el["model-select"].value : undefined,
			}),
		});
		el["new-game-panel"].close();
		connect(data.gameId);
		await Promise.all([loadGames(), loadConfig()]);
	} catch (error) {
		write("new-game-hint", error.message);
		el["new-game-hint"].classList.add("error");
	} finally {
		state.choosing = false;
		updateForm();
	}
}

function stopReplay() {
	if (state.replay !== null) clearInterval(state.replay);
	state.replay = null;
}

function setPane(pane) {
	state.pane = pane;
	state.detail = null;
	queueRender();
}

function seek(cursor, following) {
	stopReplay();
	state.cursor = cursor;
	state.following = following;
	setPane("live");
}

function restoreReader(refocus) {
	if (el.reader.parentElement !== el["reader-dialog"]) return;
	el.history.before(el.reader);
	queueRender();
	if (refocus) requestAnimationFrame(() => (el["reader-expand"].hidden
		? el["feed-tabs"].querySelector('[aria-pressed="true"]') : el["reader-expand"])?.focus());
}

el["game-select"].addEventListener("change", () => connect(el["game-select"].value));
el["view-toggle"].addEventListener("click", (event) => {
	const requested = event.target.closest("button[data-view]")?.dataset.view;
	if (!requested || requested === state.view || (requested === "god" && !state.config.godEnabled)) return;
	state.view = requested;
	if (state.id) connect(state.id);
	else queueRender();
});
el["refresh-btn"].addEventListener("click", async () => {
	await Promise.all([loadGames(), loadConfig()]);
	if ((!state.id || state.status === "error") && state.games.length) connect(el["game-select"].value);
});
el["new-game-btn"].addEventListener("click", () => {
	el["seed-input"].value = randomSeed();
	el["new-game-hint"].classList.remove("error");
	updateForm();
	el["new-game-panel"].showModal();
	void loadConfig();
});
el["new-game-close"].addEventListener("click", () => el["new-game-panel"].close());
el["new-game-form"].addEventListener("submit", startGame);
el["mode-select"].addEventListener("change", updateForm);
el["error-close"].addEventListener("click", hideError);
el["feed-tabs"].addEventListener("click", (event) => {
	const pane = event.target.closest("button[data-pane]")?.dataset.pane;
	if (pane) setPane(pane);
});
for (const [value, name] of Object.entries(INTEL)) option(el["intel-select"], value, name);
el["intel-select"].addEventListener("change", queueRender);
for (const id of ["history-filter", "history-day"]) {
	el[id].addEventListener("change", () => {
		state.historyPage = 0;
		queueRender();
	});
}
el["history-prev"].addEventListener("click", () => { state.historyPage--; queueRender(); });
el["history-next"].addEventListener("click", () => { state.historyPage++; queueRender(); });
el["reader-prev"].addEventListener("click", () => { state.readPage--; queueRender(); });
el["reader-next"].addEventListener("click", () => { state.readPage++; queueRender(); });
el["reader-expand"].addEventListener("click", () => {
	const dialog = el["reader-dialog"];
	if (dialog.open) dialog.close();
	else {
		dialog.append(el.reader);
		dialog.showModal();
		el["reader-expand"].focus();
		queueRender();
	}
});
el["reader-dialog"].addEventListener("close", () => restoreReader(true));
el["detail-back"].addEventListener("click", () => {
	const seq = state.detail?.seq;
	state.detail = null;
	queueRender();
	requestAnimationFrame(() => (el["history-items"].querySelector(`[data-seq="${seq}"]`) ?? el["history-items"].querySelector("button"))?.focus());
});
el["detail-jump"].addEventListener("click", () => {
	const cursor = state.events.findIndex((event) => event.seq === state.detail?.seq) + 1;
	if (cursor) seek(cursor, cursor === state.events.length);
});
el.scrubber.addEventListener("input", () => seek(Number(el.scrubber.value), Number(el.scrubber.value) === state.events.length));
el["latest-btn"].addEventListener("click", () => seek(state.events.length, !state.following));
el["replay-btn"].addEventListener("click", () => {
	if (state.replay !== null) {
		stopReplay();
		queueRender();
		return;
	}
	if (state.cursor >= state.events.length) state.cursor = 0;
	state.following = false;
	setPane("live");
	state.replay = setInterval(() => {
		state.cursor += 1;
		if (state.cursor >= state.events.length) {
			stopReplay();
			state.following = true;
		}
		queueRender();
	}, 600);
});
window.addEventListener("pagehide", closeSource);
window.addEventListener("pageshow", (event) => {
	if (event.persisted && state.id) connect(state.id);
});
const resize = new ResizeObserver(queueRender);
resize.observe(el["reader-content"]);
resize.observe(el["history-items"]);
document.fonts.ready.then(queueRender);

render();
void Promise.all([loadConfig(), loadGames()]).then(() => {
	const game = state.games.find((item) => item.gameId === state.config.activeGameId) ?? state.games[0];
	if (!state.id && game) connect(game.gameId);
});
