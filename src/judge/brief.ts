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

	if (view.role === "werewolf") {
		lines.push("");
		lines.push("—— 狼队战术 ——");
		if (view.wolfPlan) {
			lines.push(
				`当前计划（第 ${view.wolfPlanDay} 夜，${seatLabel(view.wolfPlanAuthor ?? view.seat)}制定）：`,
			);
			lines.push(view.wolfPlan);
		} else {
			lines.push("当前还没有狼队战术计划。");
		}
		lines.push(
			view.turn.kind === "wolf_strategy"
				? "本回合你是制定者：先复盘再提交/更新计划，不要把上一版原样复述。"
				: "计划是团队基线，不是强制命令；如果局势已经变化，先在狼队频道说明，再按你的判断行动。",
		);
	}

	const publicSummary = buildPublicSummary(view);
	if (publicSummary.length > 0) {
		lines.push("");
		lines.push("—— 公开局势摘要 ——");
		for (const line of publicSummary) lines.push(line);
	}

	const situation = buildSituationSummary(view);
	if (situation.length > 0) {
		lines.push("");
		lines.push("—— 局势面板 ——");
		for (const line of situation) lines.push(line);
	}

	lines.push("");
	lines.push("—— 自你上次行动以来的新事件 ——");
	lines.push(formatEvents(view.newEvents));
	lines.push("");
	lines.push("—— 现在需要你做的 ——");
	lines.push(view.turn.promptHint);

	const targets = targetHint(view);
	if (targets) lines.push(targets);
	lines.push(`本轮要权衡：${decisionChecklist(view.turn.kind)}`);
	return lines.join("\n");
}

function buildSituationSummary(view: PlayerView): string[] {
	const lines: string[] = [];
	const voters = view.players.filter((player) => player.canVote);
	const weight = (seat: number) => seat === view.sheriff ? view.sheriffVoteWeight : 1;
	const weighted = voters.reduce((sum, player) => sum + weight(player.seat), 0);
	lines.push(`当前有放逐票权：${formatSeatList(voters.map((player) => player.seat))}（合计 ${weighted} 票）。`);
	if (view.role === "werewolf" && view.knownWolfSeats) {
		const wolves = new Set(view.knownWolfSeats);
		const wolfWeight = voters.reduce((sum, player) => sum + (wolves.has(player.seat) ? weight(player.seat) : 0), 0);
		lines.push(`狼队当前占 ${wolfWeight} 票；其余玩家共 ${weighted - wolfWeight} 票（仅狼队可知）。`);
	}
	if (view.sheriff !== null && !voters.some((player) => player.seat === view.sheriff)) {
		lines.push("当前警徽持有者无放逐票权。");
	}
	return lines;
}

function buildPublicSummary(view: PlayerView): string[] {
	const lines: string[] = [];
	const publicEvents = view.visibleEvents.filter((event) => event.visibility.kind === "public");
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
		const tally = data.tally && typeof data.tally === "object"
			? Object.entries(data.tally).sort(([, a], [, b]) => Number(b) - Number(a))
				.map(([seat, weight]) => `${seat}号 ${weight}票`).join("、")
			: "";
		lines.push(`第 ${record.day} 天 [E${record.seq}] 放逐票：${parts.length > 0 ? parts.join("，") : "无人投票"}；${tally ? `${tally}；` : ""}${exiled}。`);
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

function targetHint(view: PlayerView): string | null {
	const { turn } = view;
	if (turn.kind === "wolf_strategy") {
		return "本回合不选刀杀目标；只提交/更新战术计划（set_wolf_plan）。";
	}
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
		case "wolf_strategy":
			return "按已见信息给主刀口、备选和白天分工；指出哪条可观察的新信息会让全队换方案。";
		case "wolf_turn":
			return "核对已投的狼队刀票。新刀口是否值得承担分票风险？若要换刀，先对队友说具体原因。";
		case "seer_check":
			return "比较两名未验活人：谁的两个可能结果最能改变归票或站边？";
		case "witch_act":
			return "比较救、毒、留药各自留下的票和最薄的一边，刀口身份未知。";
		case "sheriff_signup":
			return "上警能拿到什么、会暴露什么？你的阵营更需要警徽还是更需要隐藏？";
		case "sheriff_speech":
			return "给出拿到警徽后会做的事；有已发言对手就回应一个分歧，否则留给后置位一个具体问题。";
		case "sheriff_vote":
			return "哪个候选人更可信、更能带队？你的票会不会把警徽送给狼？";
		case "badge_transfer":
			return "哪个候选人能替你的阵营投出关键票？核对存活、票权和你已公开的承诺。";
		case "hunter_shoot":
			return "带走谁收益最大、误伤好人/神职的代价最小？";
		case "last_words":
			return "交代下一位归票者最需要的一条信息，以及可验证它的方法。";
		case "day_speech":
			return "用一条具体证据推进归票；缺线索时，点名提问并说明哪种回答会改变你的判断。";
		case "day_vote":
			return "结合公开归票和有票座位，比较两位可行目标；实际票未公布，别假设已有人投票。";
	}
}
