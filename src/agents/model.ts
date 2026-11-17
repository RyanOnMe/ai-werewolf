import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { COMMANDCODE_SPECS, shortModelName } from "./model-routing.ts";

export interface LoadedModel {
	runtime: ModelRuntime;
	model: Model<any>;
	provider: string;
	modelId: string;
	thinkingLevel: ThinkingLevel;
}

export interface LoadedModelSet {
	runtime: ModelRuntime;
	models: LoadedModel[];
	thinkingLevel: ThinkingLevel;
}

interface PiSettings {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: string;
}

const THINKING_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

export const PARATERA_PROVIDER = "paratera";
const COMMANDCODE_PROVIDER = "commandcode";
const PARATERA_DEFAULT_BASE_URL = "https://llmapi.paratera.com/v1";
const COMMANDCODE_BASE_URL = "https://api.commandcode.ai/provider/v1";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const MISSING_MODEL_AUTH = "pi 没有可用模型。请先运行 `pi auth` 登录，或在 .env 中配置 COMMANDCODE_API_KEY 或 PARATERA_API_KEY。";

/**
 * Paratera 的 OpenAI 兼容网关。只注册项目实际使用的两个模型，
 * 避免把列表里的 89 个模型全部塞进 /model。
 */
const PARATERA_MODELS = [
	{
		id: "DeepSeek-V4.1-Flash-1017",
		name: "DeepSeek V4.1 Flash 1017",
		reasoning: true,
		input: ["text"] as ("text" | "image")[],
		cost: ZERO_COST,
		contextWindow: 128000,
		maxTokens: 16384,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			maxTokensField: "max_tokens" as const,
		},
	},
	{
		id: "MiniMax-M3.1-Flash",
		name: "MiniMax M3.1 Flash",
		reasoning: true,
		input: ["text"] as ("text" | "image")[],
		cost: ZERO_COST,
		contextWindow: 128000,
		maxTokens: 16384,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			maxTokensField: "max_tokens" as const,
		},
	},
];

/** 支持从仓库根目录或当前工作目录读取 .env；shell 环境变量优先。 */
function loadDotEnv(): void {
	const moduleRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
	const candidates = [join(process.cwd(), ".env"), join(moduleRoot, ".env")];
	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		try {
			process.loadEnvFile(candidate);
			return;
		} catch {
			// 无效的 .env 不应阻止使用 shell 环境变量。
		}
	}
}

loadDotEnv();

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

async function registerParatera(runtime: ModelRuntime): Promise<void> {
	const apiKey = process.env.PARATERA_API_KEY?.trim();
	if (!apiKey) return;
	const baseUrl = process.env.PARATERA_BASE_URL?.trim() || PARATERA_DEFAULT_BASE_URL;
	runtime.registerProvider(PARATERA_PROVIDER, {
		name: "Paratera",
		baseUrl,
		api: "openai-completions",
		apiKey: "$PARATERA_API_KEY",
		models: PARATERA_MODELS,
	});
	// 同时写入运行时凭据，避免 models.json 的解析路径影响可用性判断。
	await runtime.setRuntimeApiKey(PARATERA_PROVIDER, apiKey);
}

async function registerCommandCode(runtime: ModelRuntime): Promise<void> {
	const apiKey = process.env.COMMANDCODE_API_KEY?.trim();
	if (!apiKey) return;
	runtime.registerProvider(COMMANDCODE_PROVIDER, {
		name: "Command Code",
		baseUrl: COMMANDCODE_BASE_URL,
		api: "openai-completions",
		apiKey: "$COMMANDCODE_API_KEY",
		models: COMMANDCODE_SPECS.map((spec) => ({
			id: spec.slice(COMMANDCODE_PROVIDER.length + 1),
			name: shortModelName(spec),
			reasoning: true,
			input: ["text"],
			cost: ZERO_COST,
			contextWindow: 1_000_000,
			maxTokens: 16_384,
			compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
		})),
	});
	await runtime.setRuntimeApiKey(COMMANDCODE_PROVIDER, apiKey);
}

async function createModelRuntime(): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	await registerParatera(runtime);
	await registerCommandCode(runtime);
	return runtime;
}

function availableModelNames(available: readonly Model<any>[]): string {
	return available.map((m) => `${m.provider}/${m.id}`).join(", ");
}

function resolveModelSpec(
	runtime: ModelRuntime,
	available: readonly Model<any>[],
	spec: string,
): Model<any> {
	const cleaned = spec.trim();
	if (!cleaned) throw new Error("模型名不能为空");
	const slash = cleaned.indexOf("/");
	let model: Model<any> | undefined;

	if (slash > 0) {
		const provider = cleaned.slice(0, slash);
		const modelId = cleaned.slice(slash + 1);
		model = runtime.getModel(provider, modelId) ?? undefined;
		if (!model) {
			throw new Error(`找不到模型 ${cleaned}。可用模型：${availableModelNames(available)}`);
		}
		if (!available.some((m) => m.provider === model!.provider && m.id === model!.id)) {
			throw new Error(
				`模型 ${cleaned} 没有可用鉴权（provider ${provider} 未登录或缺少 key）。可用模型：${availableModelNames(available)}`,
			);
		}
	} else {
		model =
			available.find((m) => m.id === cleaned) ??
			available.find((m) => m.id.toLowerCase() === cleaned.toLowerCase());
		if (!model) {
			throw new Error(
				`找不到模型 ${cleaned}。请使用 provider/model 形式，例如 paratera/DeepSeek-V4.1-Flash-1017。可用模型：${availableModelNames(available)}`,
			);
		}
	}
	return model;
}

/**
 * 复用 pi 自己的 ModelRuntime：它会读取 ~/.pi/agent/auth.json 的 OAuth/API key，
 * 并在请求前处理 token 刷新。Command Code 与 Paratera 通过环境变量注册。
 */
export async function loadPiModel(
	options: {
		model?: string;
		thinkingLevel?: string;
	} = {},
): Promise<LoadedModel> {
	const runtime = await createModelRuntime();
	const available = await runtime.getAvailable();
	if (available.length === 0) {
		throw new Error(MISSING_MODEL_AUTH);
	}
	const settings = readPiSettings();
	const spec = options.model?.trim();
	if (spec?.includes(",")) {
		throw new Error("loadPiModel 只接受单个模型；多个模型请使用 loadPiModels。");
	}
	let model: Model<any> | undefined;

	if (spec) {
		model = resolveModelSpec(runtime, available, spec);
	} else {
		model = available.find((m) => `${m.provider}/${m.id}` === COMMANDCODE_SPECS[0]);
		if (!model && settings.defaultProvider && settings.defaultModel) {
			model = available.find(
				(m) => m.provider === settings.defaultProvider && m.id === settings.defaultModel,
			);
		}
		if (!model) model = available[0];
	}

	if (!model) throw new Error("没有可用模型");
	const thinkingLevel = parseThinkingLevel(options.thinkingLevel ?? "low", "low");
	return {
		runtime,
		model,
		provider: model.provider,
		modelId: model.id,
		thinkingLevel,
	};
}

/**
 * 一次加载多个模型，共享同一个 ModelRuntime。
 * 玩家按座位轮流使用这些模型（seat 1 → models[0]，seat 2 → models[1] …）。
 */
export async function loadPiModels(options: {
	models: string[];
	thinkingLevel?: string;
}): Promise<LoadedModelSet> {
	const specs = [...new Set(options.models.map((model) => model.trim()).filter(Boolean))];
	if (specs.length === 0) throw new Error("至少需要一个模型");
	const runtime = await createModelRuntime();
	const available = await runtime.getAvailable();
	if (available.length === 0) {
		throw new Error(MISSING_MODEL_AUTH);
	}
	const thinkingLevel = parseThinkingLevel(options.thinkingLevel ?? "low", "low");
	const models = specs.map((spec) => {
		const model = resolveModelSpec(runtime, available, spec);
		return {
			runtime,
			model,
			provider: model.provider,
			modelId: model.id,
			thinkingLevel,
		};
	});
	return { runtime, models, thinkingLevel };
}

export async function describeAvailableModels(): Promise<string[]> {
	const runtime = await createModelRuntime();
	const available = await runtime.getAvailable();
	return available.map((model) => `${model.provider}/${model.id}`);
}
