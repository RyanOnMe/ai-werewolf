import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { withModelRetry } from "../src/agents/model-stream.ts";
import { FAKE_MODEL, errorStream } from "./fake-llm.ts";

const context = { messages: [] };

test("指数退避有次数上限，适用于抛出的错误和流式错误", async () => {
	let attempts = 0;
	const waits: number[] = [];
	const busy = errorStream("429 rate limit exceeded");
	const wrapped = withModelRetry((model, messages, options) => {
		assert.equal(options?.maxRetries, 0);
		if (++attempts === 1) {
			throw Object.assign(new Error("Bad gateway"), { status: 502 });
		}
		return busy(model, messages, options);
	}, { maxRetries: 3, baseDelayMs: 4 }, {
		onRetry: (retry) => waits.push(retry.delayMs),
	});
	const result = await (await wrapped(FAKE_MODEL, context)).result();
	assert.equal(result.stopReason, "error");
	assert.equal(attempts, 4);
	assert.ok(waits[0]! >= 3 && waits[0]! <= 5);
	assert.ok(waits[1]! >= 6 && waits[1]! <= 10);
	assert.ok(waits[2]! >= 12 && waits[2]! <= 20);
});

test("计费额度耗尽等永久错误直接返回，服务端要求等待过久也不再请求", async () => {
	for (const scenario of ["quota", "slow", "headers-before-normalization"]) {
		let attempts = 0;
		const wrapped = withModelRetry(async (model, messages, options) => {
			attempts++;
			if (scenario === "quota") return errorStream("429 insufficient_quota")(FAKE_MODEL, context);
			if (scenario === "headers-before-normalization") {
				await options?.fetch?.("http://unused.example");
				return errorStream("Request failed")(model, messages);
			}
			throw Object.assign(new Error("Too many requests"), {
				status: 429,
				headers: new Headers({ "Retry-After": "90" }),
			});
		}, { baseDelayMs: 1, maxDelayMs: 20 });
		const model = scenario === "headers-before-normalization" ? { ...FAKE_MODEL, api: "openai-completions" as const } : FAKE_MODEL;
		const result = await (await wrapped(model, context, {
			fetch: async () => new Response(null, { status: 429, headers: { "Retry-After": "90" } }),
		})).result();
		assert.equal(result.stopReason, "error");
		assert.equal(attempts, 1, scenario);
		if (scenario === "headers-before-normalization") assert.match(result.errorMessage ?? "", /^HTTP 429/);
	}
});

test("回合取消会立即结束正在等待退避或不响应的模型流", async () => {
	for (const stall of [false, true]) {
		const controller = new AbortController();
		let attempts = 0;
		const wrapped = withModelRetry(() => {
			attempts++;
			return stall ? createAssistantMessageEventStream() : errorStream("503 Service Unavailable")(FAKE_MODEL, context);
		}, { baseDelayMs: 30 }, {
			onRetry: () => controller.abort(),
		});
		const stream = await wrapped(FAKE_MODEL, context, { signal: controller.signal });
		if (stall) controller.abort();
		assert.equal((await stream.result()).stopReason, "aborted");
		await delay(45);
		assert.equal(attempts, 1);
	}
});
