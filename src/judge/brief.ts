import {
	type GameEvent,
	type PlayerView,
	type TurnKind,
	PHASE_LABEL,
	ROLE_LABEL,
	factionOf,
	seatLabel,
} from "../engine/types.ts";
import { formatEvents, formatSeatList } from "./format.ts";

/** 构造发给玩家 agent 的“本轮简报”。只包含该玩家可见的信息。 */
export function buildBrief(view: PlayerView): string {
	const lines: string[] = [];
	lines.push(
		`[法官] 第 ${view.day} 天 · ${PHASE_LABEL[view.phase]} · 回合 ${view.turn.id}`,
	);
	lines.push(
		`你是 ${seatLabel(view.seat)}，身份：${ROLE_LABEL[view.role]}（${factionOf(view.role) === "wolf" ? "狼人阵营" : "好人阵营"}），${view.alive ? "存活" : "已出局"}。`,
	);
	const sheriffText =
		view.sheriff === null ? "无警长" : `警长 ${seatLabel(view.sheriff)}（票权 ${view.sheriffVoteWeight}）`;
	const candidateText =
		view.sheriffCandidates.length > 0
			? `；警上候选人：${formatSeatList(view.sheriffCandidates)}`
			: "";
	lines.push(
		`本局：${view.playerCount} 人（${view.mode === "12p" ? "12 人局" : "9 人局"}）；${sheriffText}${candidateText}。`,
	);
	lines.push(`存活：${formatSeatList(view.aliveSeats)}；出局：${formatSeatList(view.deadSeats)}`);
	lines.push("");
	lines.push("—— 私密信息 ——");
	for (const line of view.privateInfo) lines.push(line);

	const publicSummary = buildPublicSummary(view);
	if (publicSummary.length > 0) {
		lines.push("");
		lines.push("—— 公开局势摘要 ——");
		for (const line of publicSummary) lines.push(line);
	}

	lines.push("");
	lines.push("—— 自你上次行动以来的新事件 ——");
	lines.push(formatEvents(view.newEvents));
	lines.push("");
	lines.push("—— 现在需要你做的 ——");
	lines.push(view.turn.promptHint);

	const targets = targetHint(view);
	if (targets) lines.push(targets);
	lines.push(`决策检查：${decisionChecklist(view.turn.kind)}`);
	lines.push("提示：你的自然语言输出只有你自己能看到；只有调用工具才会真正行动。");
	return lines.join("\n");
}

function buildPublicSummary(view: PlayerView): string[] {
	const lines: string[] = [];
	const publicEvents = view.visibleEvents.filter((event) => event.visibility.kind === "public");
	const claims = extractClaims(publicEvents);
	if (claims.length > 0) {
		lines.push(`公开自称（从发言自动提取，可能是谎言或反话）：${claims.join("；")}。`);
	}

	const records = publicEvents
		.filter((event) => event.type === "vote_record")
		.slice(-2);
	for (const record of records) {
		const data = record.data ?? {};
		const votes =
			data.votes && typeof data.votes === "object"
				? (data.votes as Record<string, number | "abstain">)
				: {};
		const parts = Object.entries(votes)
			.sort(([a], [b]) => Number(a) - Number(b))
			.map(([seat, target]) => `${seat}→${target === "abstain" ? "弃" : `${target}号`}`);
		const exiled =
			typeof data.exiled === "number"
				? data.idiotRevealed
					? `${data.exiled}号（白痴翻牌免死）`
					: `${data.exiled}号被放逐`
				: "无人被放逐";
		lines.push(`第 ${record.day} 天投票：${parts.length > 0 ? parts.join("，") : "无人投票"}；${exiled}。`);
	}

	const election = [...publicEvents].reverse().find((event) => event.type === "sheriff_elected");
	if (election) {
		lines.push(`警长竞选结果：${election.text}`);
	}
	const idiot = [...publicEvents].reverse().find((event) => event.type === "idiot_revealed");
	if (idiot) {
		lines.push(`白痴翻牌：${idiot.text}`);
	}
	return lines;
}

function extractClaims(events: readonly GameEvent[]): string[] {
	const claimPattern = /(?:我是|我跳|我底牌是|我这张牌是|身份是)\s*(预言家|女巫|猎人|白痴|村民)/g;
	const checkPattern =
		/(\d{1,2})\s*号\s*(?:是|为)?\s*(查杀|金水)|(查杀|金水)\s*(\d{1,2})\s*号/g;
	const claims: string[] = [];
	const seen = new Set<string>();
	const add = (text: string) => {
		if (seen.has(text) || claims.length >= 8) return;
		seen.add(text);
		claims.push(text);
	};
	const relevant = events
		.filter(
			(event) =>
				event.type === "speech" ||
				event.type === "sheriff_speech" ||
				event.type === "last_words",
		)
		.slice(-40);
	for (const event of relevant) {
		const actor = event.actor === null ? "某位玩家" : seatLabel(event.actor);
		for (const match of event.text.matchAll(claimPattern)) {
			add(`${actor}自称${match[1]}`);
		}
		for (const match of event.text.matchAll(checkPattern)) {
			const targetSeat = match[1] ?? match[4];
			const kind = match[2] ?? match[3];
			if (targetSeat && kind) add(`${actor}报${targetSeat}号${kind}`);
		}
	}
	return claims;
}

function targetHint(view: PlayerView): string | null {
	const { turn } = view;
	if (turn.kind === "wolf_turn") {
		return `可刀杀目标：${formatSeatList(turn.legalTargets)}；也可以 no_kill（空刀）。`;
	}
	if (turn.kind === "witch_act") {
		const victim =
			turn.witchVictim === null || turn.witchVictim === undefined
				? "今晚无人被刀"
				: `今晚被刀：${seatLabel(turn.witchVictim)}`;
		return `${victim}。解药${turn.canSave ? "可用" : "不可用"}，毒药${turn.canPoison ? "可用" : "不可用"}；可毒杀目标：${formatSeatList(turn.legalTargets)}。`;
	}
	if (turn.kind === "sheriff_signup") {
		return "run=true 上警；run=false 不上警。上警后会在警上发言，再由警下投票。";
	}
	if (turn.kind === "sheriff_speech") {
		return `当前警上候选人：${formatSeatList(turn.sheriffCandidates ?? [])}；你的发言所有玩家可见。`;
	}
	if (turn.kind === "sheriff_vote") {
		return `可投候选人：${formatSeatList(turn.legalTargets)}；abstain=弃票。`;
	}
	if (turn.kind === "badge_transfer") {
		return `可接警徽：${formatSeatList(turn.legalTargets)}；target: null=销毁警徽。`;
	}
	if (turn.kind === "day_vote") {
		return `可投票目标：${formatSeatList(turn.legalTargets)}；abstain=弃票。${turn.isSheriff ? `你是警长，本票权重 ${view.sheriffVoteWeight}。` : ""}`;
	}
	if (turn.kind === "hunter_shoot") {
		return `可开枪目标：${formatSeatList(turn.legalTargets)}；target: null=放弃。`;
	}
	if (turn.kind === "seer_check") {
		return `可查验目标：${formatSeatList(turn.legalTargets)}。`;
	}
	return null;
}

function decisionChecklist(kind: TurnKind): string {
	switch (kind) {
		case "wolf_turn":
			return "刀谁最符合屠边/隐藏收益？白天你准备讲什么故事来配合刀口？";
		case "seer_check":
			return "验谁最能验证一个关键站边或悍跳位？下一轮白天准备怎么报？";
		case "witch_act":
			return "这一救/一毒会让哪边更接近胜利？有没有可能是自刀或骗药？";
		case "sheriff_signup":
			return "上警能拿到什么、会暴露什么？你的阵营更需要警徽还是更需要隐藏？";
		case "sheriff_speech":
			return "你的身份/站边、警徽流和今天归票是什么？狼人要把假故事编完整。";
		case "sheriff_vote":
			return "哪个候选人更可信、更能带队？你的票会不会把警徽送给狼？";
		case "badge_transfer":
			return "谁最可信？给错人等于把 1.5 票送给对方；没有可信目标就销毁。";
		case "hunter_shoot":
			return "带走谁收益最大、误伤好人/神职的代价最小？";
		case "last_words":
			return "把关键查验、狼坑和下一轮安排交代清楚；不要浪费遗言。";
		case "day_speech":
			return "这轮你至少要给一个具体站边/怀疑/归票，并解释理由；不要空过。";
		case "day_vote":
			return "这一票如何推动你的阵营获胜？和你刚说过的话是否一致？";
	}
}
