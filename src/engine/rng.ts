/** 可复现的伪随机数生成器。游戏内一切随机都走这里，保证同一 seed 可重放。 */

export interface Rng {
	next(): number;
	int(maxExclusive: number): number;
	pick<T>(items: readonly T[]): T;
	shuffle<T>(items: readonly T[]): T[];
}

function hashSeed(seed: string): number {
	let h = 2166136261 >>> 0;
	for (let i = 0; i < seed.length; i++) {
		h ^= seed.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

function mulberry32(a: number): () => number {
	return function next() {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function createRng(seed: string): Rng {
	const next = mulberry32(hashSeed(seed));
	return {
		next,
		int(maxExclusive: number): number {
			if (maxExclusive <= 0) throw new Error("maxExclusive must be positive");
			return Math.floor(next() * maxExclusive);
		},
		pick<T>(items: readonly T[]): T {
			if (items.length === 0) throw new Error("cannot pick from empty array");
			return items[Math.floor(next() * items.length)] as T;
		},
		shuffle<T>(items: readonly T[]): T[] {
			const out = [...items];
			for (let i = out.length - 1; i > 0; i--) {
				const j = Math.floor(next() * (i + 1));
				const tmp = out[i] as T;
				out[i] = out[j] as T;
				out[j] = tmp;
			}
			return out;
		},
	};
}

/** 从 from 的下一个座位开始，按座位号升序（环绕）找到第一个满足条件的座位。 */
export function nextSeatWhere(
	from: number,
	playerCount: number,
	predicate: (seat: number) => boolean,
): number | null {
	for (let offset = 1; offset <= playerCount; offset++) {
		const seat = ((from - 1 + offset) % playerCount) + 1;
		if (predicate(seat)) return seat;
	}
	return null;
}
