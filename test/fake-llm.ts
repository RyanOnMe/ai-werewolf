import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type Context,
	type Model,
	type StopReason,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { setTimeout as delay } from "node:timers/promises";

export const FAKE_MODEL: Model<"fake-api"> = {
	id: "fake-model",
	name: "Fake Model",
	api: "fake-api",
	provider: "fake",
	baseUrl: "http://fake",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
};

export type FakeStep =
	| { name: string; args: Record<string, unknown> }
	| { text: string }
	| { calls: { name: string; args: Record<string, unknown> }[] };

export type FakePlanner = (context: Context, callIndex: number) => FakeStep;

function makeMessage(content: AssistantMessage["content"], stopReason: StopReason): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "fake-api",
		provider: "fake",
		model: "fake-model",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

export function fakeStream(planner: FakePlanner): StreamFn {
	let callIndex = 0;
	return (_model, context) => {
		const step = planner(context, callIndex++);
		let message: AssistantMessage;
		if ("text" in step) {
			message = makeMessage([{ type: "text", text: step.text }], "stop");
		} else {
			const calls = "calls" in step ? step.calls : [{ name: step.name, args: step.args }];
			message = makeMessage(
				calls.map((call, index) => ({
					type: "toolCall" as const,
					id: `fake-call-${callIndex}-${index}`,
					name: call.name,
					arguments: call.args,
				})),
				"toolUse",
			);
		}
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: message });
			stream.push({
				type: "done",
				reason: message.stopReason === "stop" ? "stop" : "toolUse",
				message,
			});
			stream.end(message);
		});
		return stream;
	};
}

export function errorStream(errorMessage: string): StreamFn {
	return () => {
		const message = makeMessage([{ type: "text", text: "" }], "error");
		message.errorMessage = errorMessage;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: message });
			stream.push({ type: "error", reason: "error", error: message });
			stream.end(message);
		});
		return stream;
	};
}

export function streamedTool(
	name: string,
	field: string,
	chunks: string[],
	options: { intervalMs?: number; error?: string; privateText?: string } = {},
): ReturnType<typeof createAssistantMessageEventStream> {
	const stream = createAssistantMessageEventStream();
	void (async () => {
		const body = options.privateText ? [{ type: "text" as const, text: options.privateText }] : [];
		const index = body.length;
		const partial = makeMessage(body, "toolUse");
		stream.push({ type: "start", partial });
		if (options.privateText) {
			stream.push({ type: "text_delta", contentIndex: 0, delta: options.privateText, partial });
		}
		let text = "";
		for (const chunk of chunks) {
			text += chunk;
			const toolCall = { type: "toolCall" as const, id: "streamed-tool", name, arguments: { [field]: text } };
			const update = { ...partial, content: [...body, toolCall] };
			stream.push({ type: "toolcall_delta", contentIndex: index, delta: chunk, partial: update });
			if (options.intervalMs) await delay(options.intervalMs);
		}
		const message = makeMessage([...body, {
			type: "toolCall", id: "streamed-tool", name, arguments: { [field]: text },
		}], options.error ? "error" : "toolUse");
		if (options.error) {
			message.errorMessage = options.error;
			stream.push({ type: "error", reason: "error", error: message });
		} else {
			stream.push({ type: "done", reason: "toolUse", message });
		}
		stream.end(message);
	})();
	return stream;
}
