import { type PlayerView, PHASE_LABEL, ROLE_LABEL, factionOf, seatLabel } from "../engine/types.ts";
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
	lines.push(`存活：${formatSeatList(view.aliveSeats)}；出局：${formatSeatList(view.deadSeats)}`);
	lines.push("");
	lines.push("—— 私密信息 ——");
	for (const line of view.privateInfo) lines.push(line);
	lines.push("");
	lines.push("—— 自你上次行动以来的新事件 ——");
	lines.push(formatEvents(view.newEvents));
	lines.push("");
	lines.push("—— 现在需要你做的 ——");
	lines.push(view.turn.promptHint);

	const targets = targetHint(view);
	if (targets) lines.push(targets);
	lines.push("提示：你的自然语言输出只有你自己能看到；只有调用工具才会真正行动。");
	return lines.join("\n");
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
	if (turn.kind === "day_vote") {
		return `可投票目标：${formatSeatList(turn.legalTargets)}；abstain=弃票。`;
	}
	if (turn.kind === "hunter_shoot") {
		return `可开枪目标：${formatSeatList(turn.legalTargets)}；target: null=放弃。`;
	}
	if (turn.kind === "seer_check") {
		return `可查验目标：${formatSeatList(turn.legalTargets)}。`;
	}
	return null;
}
