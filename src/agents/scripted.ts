import {
	type Action,
	type PlayerPolicy,
	type PlayerView,
	type TurnRequest,
	ROLE_LABEL,
} from "../engine/types.ts";
import { createRng, type Rng } from "../engine/rng.ts";

/** 无 LLM 的随机策略：用于规则验证、流程压力测试和演示。 */
export class RandomPolicy implements PlayerPolicy {
	readonly seat: number;
	private readonly rng: Rng;
	private readonly gameSeed: string;

	constructor(seat: number, gameSeed: string) {
		this.seat = seat;
		this.gameSeed = gameSeed;
		this.rng = createRng(`${gameSeed}:seat-${seat}:random-policy`);
	}

	async decide(turn: TurnRequest, view: PlayerView): Promise<Action> {
		const others = view.aliveSeats.filter((seat) => seat !== view.seat);
		switch (turn.kind) {
			case "wolf_turn": {
				const vote =
					others.length === 0 || this.rng.next() < 0.1
						? "no_kill"
						: this.rng.pick(turn.legalTargets);
				const speech =
					this.rng.next() < 0.5
						? ""
						: vote === "no_kill"
							? "今晚建议空刀。"
							: `我建议刀 ${vote} 号。`;
				return { kind: "wolf_turn", seat: this.seat, speech, vote };
			}
			case "seer_check":
				return {
					kind: "seer_check",
					seat: this.seat,
					target: this.rng.pick(turn.legalTargets),
				};
			case "witch_act": {
				const canSave = turn.canSave === true;
				const canPoison = turn.canPoison === true && turn.legalTargets.length > 0;
				const roll = this.rng.next();
				if (canSave && roll < 0.25) {
					return { kind: "witch_act", seat: this.seat, save: true, poisonTarget: null };
				}
				if (canPoison && roll > 0.75) {
					return {
						kind: "witch_act",
						seat: this.seat,
						save: false,
						poisonTarget: this.rng.pick(turn.legalTargets),
					};
				}
				return { kind: "witch_act", seat: this.seat, save: false, poisonTarget: null };
			}
			case "last_words":
				return {
					kind: "last_words",
					seat: this.seat,
					text: `我是${ROLE_LABEL[view.role]}，游戏继续。`,
				};
			case "hunter_shoot": {
				if (this.rng.next() < 0.5) {
					return {
						kind: "hunter_shoot",
						seat: this.seat,
						target: this.rng.pick(turn.legalTargets),
					};
				}
				return { kind: "hunter_shoot", seat: this.seat, target: null };
			}
			case "day_speech": {
				if (others.length === 0 || this.rng.next() < 0.25) {
					return { kind: "day_speech", seat: this.seat, text: "我暂时没有信息，先过。" };
				}
				const suspect = this.rng.pick(others);
				return {
					kind: "day_speech",
					seat: this.seat,
					text: `我是 ${this.seat} 号。我先听一圈，目前比较怀疑 ${suspect} 号。`,
				};
			}
			case "day_vote": {
				if (turn.legalTargets.length === 0 || this.rng.next() < 0.1) {
					return { kind: "day_vote", seat: this.seat, target: "abstain" };
				}
				return {
					kind: "day_vote",
					seat: this.seat,
					target: this.rng.pick(turn.legalTargets),
				};
			}
		}
	}
}

/** 测试用：把决策委托给一个函数，未处理的情况可回退到 fallback。 */
export class FnPolicy implements PlayerPolicy {
	readonly seat: number;
	private readonly fn: (turn: TurnRequest, view: PlayerView) => Action | undefined | Promise<Action | undefined>;
	private readonly fallback?: PlayerPolicy;

	constructor(
		seat: number,
		fn: (turn: TurnRequest, view: PlayerView) => Action | undefined | Promise<Action | undefined>,
		fallback?: PlayerPolicy,
	) {
		this.seat = seat;
		this.fn = fn;
		this.fallback = fallback;
	}

	async decide(turn: TurnRequest, view: PlayerView): Promise<Action> {
		const action = await this.fn(turn, view);
		if (action) return action;
		if (this.fallback) return this.fallback.decide(turn, view);
		throw new Error(`FnPolicy(${this.seat}) 没有为 ${turn.kind} 提供动作`);
	}
}
