export interface ModelSetInfo {
	/** 传给 CLI/server 的逗号分隔模型列表。 */
	id: string;
	label: string;
	specs: string[];
}

export const DUAL_PARATERA_SPECS = [
	"paratera/DeepSeek-V4.1-Flash-1017",
	"paratera/MiniMax-M3.1-Flash",
] as const;

export const COMMANDCODE_SPECS = [
	"commandcode/deepseek/deepseek-v4.1-flash",
	"commandcode/minimax/minimax-m3.1-flash",
] as const;

const MODEL_LABELS: Record<string, string> = {
	"paratera/DeepSeek-V4.1-Flash-1017": "DeepSeek V4.1 Flash 1017",
	"paratera/MiniMax-M3.1-Flash": "MiniMax M3.1 Flash",
	"commandcode/deepseek/deepseek-v4.1-flash": "DeepSeek V4.1 Flash",
	"commandcode/minimax/minimax-m3.1-flash": "MiniMax M3.1 Flash",
};

/** 接受 "a,b" 或 ["a","b"]，去空、去重并保留顺序。 */
export function splitModelSpecs(input: unknown): string[] {
	const raw = Array.isArray(input)
		? input
		: typeof input === "string"
			? input.split(",")
			: [];
	return [...new Set(raw.map((value) => String(value).trim()).filter(Boolean))];
}

export function shortModelName(spec: string): string {
	return MODEL_LABELS[spec] ?? spec;
}

/** 座位从 1 开始，按顺序循环分配。 */
export function assignModelForSeat(models: readonly string[], seat: number): string | undefined {
	if (models.length === 0) return undefined;
	const index = (Math.max(1, seat) - 1) % models.length;
	return models[index];
}

export function buildModelSets(models: readonly string[]): ModelSetInfo[] {
	const sets: ModelSetInfo[] = [];
	if (COMMANDCODE_SPECS.every((spec) => models.includes(spec))) {
		sets.push({
			id: COMMANDCODE_SPECS.join(","),
			label: "双模型交替 · DeepSeek V4.1 Flash + MiniMax M3.1 Flash（Command Code）",
			specs: [...COMMANDCODE_SPECS],
		});
	}
	if (DUAL_PARATERA_SPECS.every((spec) => models.includes(spec))) {
		sets.push({
			id: DUAL_PARATERA_SPECS.join(","),
			label: "双模型交替 · DeepSeek V4.1 Flash + MiniMax M3.1 Flash",
			specs: [...DUAL_PARATERA_SPECS],
		});
	}
	return sets;
}

/** 例：1/3/5/7/9 号 → DeepSeek …；2/4/6/8 号 → MiniMax … */
export function assignmentSummary(specs: readonly string[], playerCount: number): string {
	if (specs.length <= 1) return specs[0] ? shortModelName(specs[0]) : "无";
	const groups = specs.map(() => [] as number[]);
	for (let seat = 1; seat <= playerCount; seat += 1) {
		groups[(seat - 1) % specs.length]!.push(seat);
	}
	return groups
		.map((seats, index) => `${seats.join("/")}号 → ${shortModelName(specs[index]!)}`)
		.join("；");
}
