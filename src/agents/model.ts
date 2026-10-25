import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";

export interface LoadedModel {
	runtime: ModelRuntime;
	model: Model<any>;
	provider: string;
	modelId: string;
	thinkingLevel: ThinkingLevel;
}

interface PiSettings {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: string;
}

const THINKING_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

function readPiSettings(): PiSettings {
	try {
		const raw = readFileSync(join(getAgentDir(), "settings.json"), "utf8");
		return JSON.parse(raw) as PiSettings;
	} catch {
		return {};
	}
}

function parseThinkingLevel(value: string | undefined, fallback: ThinkingLevel): ThinkingLevel {
	if (!value) return fallback;
	if (!THINKING_LEVELS.has(value)) {
		throw new Error(
			`无效的 thinking level: ${value}（可选：minimal, low, medium, high, xhigh, max）`,
		);
	}
	return value as ThinkingLevel;
}

/**
 * 复用 pi 自己的 ModelRuntime：它会读取 ~/.pi/agent/auth.json 的 OAuth/API key，
 * 并在请求前处理 token 刷新。这样玩家 agent 与 pi CLI 使用同一套模型鉴权。
 */
export async function loadPiModel(options: {
	model?: string;
	thinkingLevel?: string;
} = {}): Promise<LoadedModel> {
	const runtime = await ModelRuntime.create({
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const available = await runtime.getAvailable();
	if (available.length === 0) {
		throw new Error(
			"pi 没有可用模型。请先运行 `pi auth` 登录，或设置对应 provider 的 API key 环境变量。",
		);
	}
	const settings = readPiSettings();
	const spec = options.model?.trim();
	let model: Model<any> | undefined;

	if (spec) {
		const slash = spec.indexOf("/");
		if (slash > 0) {
			const provider = spec.slice(0, slash);
			const modelId = spec.slice(slash + 1);
			model = runtime.getModel(provider, modelId) ?? undefined;
			if (!model) {
				throw new Error(
					`找不到模型 ${spec}。可用模型：${available.map((m) => `${m.provider}/${m.id}`).join(", ")}`,
				);
			}
			if (!available.some((m) => m.provider === model!.provider && m.id === model!.id)) {
				throw new Error(
					`模型 ${spec} 没有可用鉴权（provider ${provider} 未登录或缺少 key）。可用模型：${available.map((m) => `${m.provider}/${m.id}`).join(", ")}`,
				);
			}
		} else {
			model = available.find((m) => m.id === spec);
			if (!model) {
				throw new Error(
					`找不到模型 ${spec}。请使用 provider/model 形式，例如 openai-codex/gpt-5.6-luna。可用模型：${available.map((m) => `${m.provider}/${m.id}`).join(", ")}`,
				);
			}
		}
	} else {
		if (settings.defaultProvider && settings.defaultModel) {
			model = available.find(
				(m) => m.provider === settings.defaultProvider && m.id === settings.defaultModel,
			);
		}
		if (!model) model = available[0];
	}

	if (!model) throw new Error("没有可用模型");
	const thinkingLevel = parseThinkingLevel(
		options.thinkingLevel ?? "low",
		"low",
	);
	return {
		runtime,
		model,
		provider: model.provider,
		modelId: model.id,
		thinkingLevel,
	};
}

export async function describeAvailableModels(): Promise<string[]> {
	const runtime = await ModelRuntime.create({
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const available = await runtime.getAvailable();
	return available.map((model) => `${model.provider}/${model.id}`);
}
