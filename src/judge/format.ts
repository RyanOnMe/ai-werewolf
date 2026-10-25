import { type GameEvent, seatLabel } from "../engine/types.ts";

/** 把事件渲染成一行人类/agent 可读文本。不在这里做可见性判断。 */
export function formatEvent(event: GameEvent): string {
	const prefix = `[E${event.seq}]`;
	switch (event.type) {
		case "speech":
			return `${prefix} ${seatLabel(event.actor ?? 0)} 发言：${event.text}`;
		case "last_words":
			return `${prefix} ${seatLabel(event.actor ?? 0)} 遗言：${event.text}`;
		case "wolf_speech":
			return `${prefix} 狼队频道 ${seatLabel(event.actor ?? 0)}：${event.text}`;
		case "seer_result":
		case "witch_info":
		case "witch_action":
			return `${prefix} 法官私信：${event.text}`;
		case "role_assigned":
			return `${prefix} 身份：${event.text}`;
		default:
			return `${prefix} ${event.text}`;
	}
}

export function formatEvents(events: readonly GameEvent[]): string {
	if (events.length === 0) return "（无新事件）";
	return events.map(formatEvent).join("\n");
}

export function formatSeatList(seats: readonly number[]): string {
	if (seats.length === 0) return "无";
	return seats.map(seatLabel).join("、");
}
