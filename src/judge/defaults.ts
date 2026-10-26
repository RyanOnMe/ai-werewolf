import { type Action, type PlayerView, RuleError } from "../engine/types.ts";

/** 模型超时/失败/拒绝行动时的保底动作，必须合法。 */
export function defaultActionFor(view: PlayerView): Action {
	const { turn } = view;
	switch (turn.kind) {
		case "wolf_turn":
			return { kind: "wolf_turn", seat: turn.seat, speech: "", vote: "no_kill" };
		case "seer_check": {
			const target = turn.legalTargets[0];
			if (target === undefined) throw new RuleError("no_default_target", "预言家没有可查验目标");
			return { kind: "seer_check", seat: turn.seat, target };
		}
		case "witch_act":
			return { kind: "witch_act", seat: turn.seat, save: false, poisonTarget: null };
		case "last_words":
			return { kind: "last_words", seat: turn.seat, text: "（无遗言）" };
		case "hunter_shoot":
			return { kind: "hunter_shoot", seat: turn.seat, target: null };
		case "sheriff_signup":
			return { kind: "sheriff_signup", seat: turn.seat, run: false };
		case "sheriff_speech":
			return {
				kind: "sheriff_speech",
				seat: turn.seat,
				text: "我上警，先听其他候选人的发言，再给出我的判断。",
			};
		case "sheriff_vote":
			return { kind: "sheriff_vote", seat: turn.seat, target: "abstain" };
		case "badge_transfer":
			return { kind: "badge_transfer", seat: turn.seat, target: null };
		case "day_speech":
			return {
				kind: "day_speech",
				seat: turn.seat,
				text: "我暂时没有更多信息，选择过。",
			};
		case "day_vote":
			return { kind: "day_vote", seat: turn.seat, target: "abstain" };
	}
}
