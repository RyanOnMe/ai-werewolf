import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type Context,
	type Model,
	type StopReason,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

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
