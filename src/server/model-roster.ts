import { assignModelForSeat, shortModelName, splitModelSpecs } from "../agents/model-routing.ts";

// 先看模型家族，再看 provider。Paratera、OpenRouter 等网关可以代理多个品牌。
const FAMILIES = [
	["deepseek", /\bdeepseek\b/],
	["minimax", /\bminimax\b/],
	["claude", /\b(?:claude|anthropic)\b/],
	["gemini", /\b(?:gemini|gemma)\b/],
	["qwen", /\b(?:qwen\d*|qwq|alibaba|dashscope)\b/],
	["grok", /\bgrok\b/],
	["mistral", /\b(?:mistral|mixtral|codestral|pixtral|devstral|magistral)\b/],
	["kimi", /\b(?:kimi|moonshot)\b/],
	["zai", /\b(?:chatglm|glm\d*|zhipu)\b/],
	["meta", /\b(?:llama\d*|meta-llama)\b/],
	["cohere", /\b(?:cohere|command-[ra])\b/],
	["doubao", /\bdoubao\b/],
	["hunyuan", /\bhunyuan\b/],
	["perplexity", /\b(?:perplexity|sonar)\b/],
	["openai", /\b(?:gpt|openai|codex|o[1-9])\b/],
] as const;

const PROVIDER_LOGOS = new Map<string, string>([
	["openai", "openai"], ["openai-codex", "openai"], ["azure-openai-responses", "openai"],
	["anthropic", "claude"], ["google", "gemini"], ["google-vertex", "gemini"],
	["google-gemini-cli", "gemini"], ["xai", "grok"], ["zai", "zai"],
]);

function familyOf(value: string): string | undefined {
	return FAMILIES.find(([, pattern]) => pattern.test(value.toLowerCase().replace(/_/g, "-")))?.[0];
}

export function modelCard(spec: string): { spec: string; label: string; logo: string | null } {
	const slash = spec.indexOf("/");
	const provider = slash > 0 ? spec.slice(0, slash).toLowerCase() : "";
	const model = spec.slice(slash + 1);
	const logo = familyOf(model) ?? PROVIDER_LOGOS.get(provider) ?? familyOf(provider);
	const label = shortModelName(spec);
	return { spec, label: label === spec ? (model.split("/").at(-1) || spec) : label, logo: logo ? `/models/${logo}.svg` : null };
}

export function buildModelRoster(specs: string[], playerCount: number) {
	return Array.from({ length: playerCount }, (_, index) => {
		const seat = index + 1;
		const spec = assignModelForSeat(specs, seat);
		return { seat, model: spec ? modelCard(spec) : null };
	});
}

/** 旧回放可能只有 model 字段；只提取可公开的模型 ID。 */
export function savedModelSpecs(metadata: Record<string, unknown> | undefined): string[] {
	const specs = Array.isArray(metadata?.models) ? metadata.models.filter((spec) => typeof spec === "string") : [];
	return splitModelSpecs(specs.length > 0 ? specs : metadata?.model);
}
