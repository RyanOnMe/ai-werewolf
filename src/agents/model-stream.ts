import { setTimeout as delay } from "node:timers/promises";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	createAssistantMessageEventStream,
	isRetryableAssistantError,
	type AssistantMessage,
	type AssistantMessageEvent,
	type FetchFunction,
	type ProviderResponse,
} from "@earendil-works/pi-ai";
import type { ModelRetry } from "../engine/types.ts";

export interface RetryOptions {
	/** 不含首个请求。 */
	maxRetries: number;
	baseDelayMs: number;
	maxDelayMs: number;
}

interface StreamHooks {
	onChunk?: (event: AssistantMessageEvent) => void;
	onRetry?: (retry: ModelRetry, usage: AssistantMessage["usage"]) => void;
	onAttempt?: () => void;
}

type RequestError = Error & {
	status?: number;
	statusCode?: number;
	code?: string;
	headers?: Headers | Record<string, string>;
};

const DEFAULT_RETRY: RetryOptions = { maxRetries: 3, baseDelayMs: 750, maxDelayMs: 15_000 };
const FATAL_MODEL_ERROR = /not supported|\b(?:401|403)\b|unauthori[sz]ed|forbidden|invalid[_ ]api[_ ]key|authentication|not configured|(?:missing|no).*api key|insufficient[_ -](?:quota|funds|balance)|quota (?:exhausted|depleted|exceeded)|usage limit|out of budget|billing|payment required|model.*not found/i;
const APIS_WITH_CUSTOM_FETCH = new Set([
	"openai-completions", "openai-responses", "openai-codex-responses", "azure-openai-responses", "anthropic-messages",
]);

export function isFatalModelError(message: string | null | undefined): boolean {
	return Boolean(message && FATAL_MODEL_ERROR.test(message));
}

function statusFrom(message: string): number | undefined {
	const match = /(?:^|\bHTTP[\s:(]+|\bstatus(?: code)?[\s:(]+|\()(\d{3})\b/i.exec(message);
	return match ? Number(match[1]) : undefined;
}

function retryReason(final: AssistantMessage, status?: number, code?: string): ModelRetry["reason"] | null {
	if (final.stopReason !== "error") return null;
	const message = final.errorMessage ?? "";
	if (isFatalModelError(message)) return null;
	if (status === 429) return "rate_limit";
	if (status === 408) return "timeout";
	if (status === 409 || status === 425 || (status !== undefined && status >= 500 && status <= 599)) {
		return "upstream";
	}
	if (status !== undefined && status >= 400) return null;
	if (/rate[ _-]?limit|too many requests|throttl/i.test(message)) return "rate_limit";
	if (/overloaded|service unavailable|bad gateway|server error|internal server error|temporarily unavailable/i.test(message)) return "upstream";
	if (/timed? ?out|timeout/i.test(message)) return "timeout";
	if (/ECONNRESET|ECONNREFUSED|EPIPE|EAI_AGAIN|ETIMEDOUT|UND_ERR_SOCKET|fetch failed|network error|connection error|connection (?:closed|reset|refused|terminated)|socket hang up|stream (?:ended|closed|disconnected)|no response body|^terminated$/i.test(`${message}${code ? ` ${code}` : ""}`)) {
		return "connection";
	}
	return isRetryableAssistantError(final) ? "upstream" : null;
}

function retryAfter(headers?: Headers | Record<string, string>): number {
	if (!headers) return 0;
	const get = (key: string) =>
		headers instanceof Headers
			? headers.get(key)
			: Object.entries(headers).find(([name]) => name.toLowerCase() === key)?.[1];
	const ms = get("retry-after-ms");
	if (ms && Number.isFinite(Number(ms))) return Math.max(0, Number(ms));
	const value = get("retry-after");
	if (!value) return 0;
	const parsed = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
	return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

/**
 * 重试单个模型响应，不重跑 agent prompt。pi 只在收到最终成功消息后执行工具；
 * 中途断掉的 tool call 从不进入历史或执行。上层回合的 AbortSignal 覆盖所有尝试和等待。
 */
export function withModelRetry(base: StreamFn, retryOptions: Partial<RetryOptions> = {}, hooks: StreamHooks = {}): StreamFn {
	const retry = { ...DEFAULT_RETRY, ...retryOptions };
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const signal = options?.signal;
		let closed = false;
		let started = false;

		const failureMessage = (message: string, stopReason: "error" | "aborted" = "error"): AssistantMessage => ({
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			timestamp: Date.now(),
			usage: {
				input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason,
			errorMessage: message,
		});

		function finish(message: AssistantMessage): void {
			if (closed) return;
			closed = true;
			signal?.removeEventListener("abort", abort);
			const reason = message.stopReason;
			if (reason === "error" || reason === "aborted") {
				stream.push({ type: "error", reason, error: { ...message, content: [] } });
			} else {
				stream.push({ type: "done", reason: reason === "pending" ? "stop" : reason, message });
			}
			stream.end();
		}

		function abort(): void {
			finish(failureMessage("模型请求已取消", "aborted"));
		}

		if (signal?.aborted) {
			abort();
			return stream;
		}
		signal?.addEventListener("abort", abort, { once: true });

		const run = async (): Promise<void> => {
			for (let attempt = 0; !closed; attempt++) {
				if (attempt > 0) hooks.onAttempt?.();
				const responseInfo: { failure?: ProviderResponse; http?: Pick<Response, "status" | "headers"> } = {};
				const fetch: FetchFunction = async (...args) => {
					const response = await (options?.fetch ?? globalThis.fetch)(...args);
					if (response.status >= 400) responseInfo.http = response;
					return response;
				};
				let caught: RequestError | undefined;
				let final: AssistantMessage;
				try {
					const source = await base(model, context, {
						...options,
						// SDK 可能把失败响应压成纯错误文本，保留原始 Retry-After。
						...(APIS_WITH_CUSTOM_FETCH.has(model.api) ? { fetch } : {}),
						maxRetries: 0,
						onResponse: (response, resolvedModel) => {
							if (response.status >= 400) responseInfo.failure = response;
							return options?.onResponse?.(response, resolvedModel);
						},
					});
					let result: AssistantMessage | undefined;
					for await (const event of source) {
						if (closed) return;
						if (event.type === "done" || event.type === "error") {
							result = event.type === "done" ? event.message : event.error;
							break;
						}
						hooks.onChunk?.(event);
						if (!started) {
							started = true;
							stream.push({ type: "start", partial: event.partial });
						}
						if (event.type !== "start") stream.push(event);
					}
					// 允许适配器只用 end(message) 收尾；异常结束且没有 final 时不阻塞回合。
					result ??= await Promise.race([source.result(), Promise.resolve(undefined)]);
					final = result ?? failureMessage("Model stream ended without a final response");
				} catch (error) {
					caught = error instanceof Error ? error : new Error(String(error));
					final = failureMessage(caught.message, caught.name === "AbortError" ? "aborted" : "error");
				}

				if (closed) return;
				const message = final.errorMessage ?? "";
				const status = responseInfo.failure?.status ?? responseInfo.http?.status ?? caught?.status ?? caught?.statusCode ?? statusFrom(message);
				const causeCode = (caught?.cause as { code?: string } | undefined)?.code;
				const reason = retryReason(final, status, caught?.code ?? causeCode);
				const wait = Math.max(
					Math.min(retry.maxDelayMs, Math.round(retry.baseDelayMs * 2 ** attempt * (0.75 + Math.random() * 0.5))),
					retryAfter(responseInfo.failure?.headers ?? responseInfo.http?.headers ?? caught?.headers),
				);
				if (!reason || attempt >= retry.maxRetries || wait > retry.maxDelayMs) {
					const errorMessage = final.stopReason === "error" && status && !statusFrom(message)
						? `HTTP ${status}: ${message}`
						: final.errorMessage;
					finish({ ...final, errorMessage });
					return;
				}

				hooks.onRetry?.({ attempt: attempt + 1, delayMs: wait, reason }, final.usage);
				await delay(wait, undefined, { signal });
			}
		};

		void run().catch((error: unknown) => {
			if (!closed) finish(failureMessage(error instanceof Error ? error.message : String(error)));
		});
		return stream;
	};
}
