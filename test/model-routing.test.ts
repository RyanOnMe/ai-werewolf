import test from "node:test";
import assert from "node:assert/strict";
import {
	assignmentSummary,
	assignModelForSeat,
	buildModelSets,
	COMMANDCODE_SPECS,
	shortModelName,
	splitModelSpecs,
} from "../src/agents/model-routing.ts";

const DS = "paratera/DeepSeek-V4.1-Flash-1017";
const MM = "paratera/MiniMax-M3.1-Flash";

test("模型列表：逗号/数组输入会去空去重并保留顺序", () => {
	assert.deepEqual(splitModelSpecs(" a, b ,a, "), ["a", "b"]);
	assert.deepEqual(splitModelSpecs(["a", "a", " b "]), ["a", "b"]);
	assert.deepEqual(splitModelSpecs(undefined), []);
	assert.deepEqual(splitModelSpecs([DS, MM]), [DS, MM]);
});

test("双模型按座位交替分配", () => {
	assert.equal(assignModelForSeat([DS, MM], 1), DS);
	assert.equal(assignModelForSeat([DS, MM], 2), MM);
	assert.equal(assignModelForSeat([DS, MM], 3), DS);
	assert.equal(assignModelForSeat([DS, MM], 12), MM);
	assert.equal(assignModelForSeat([DS], 7), DS);
	assert.equal(assignModelForSeat([], 1), undefined);
});

test("只有两个 Paratera 模型都存在时才提供双模型组合", () => {
	assert.equal(buildModelSets([DS]).length, 0);
	assert.equal(buildModelSets([DS, "openai-codex/gpt-5.6-luna"]).length, 0);
	const sets = buildModelSets([DS, MM, "openai-codex/gpt-5.6-luna"]);
	assert.equal(sets.length, 1);
	assert.equal(sets[0]!.id, `${DS},${MM}`);
	assert.deepEqual(sets[0]!.specs, [DS, MM]);
});

test("座位分配摘要和短名适合直接展示", () => {
	assert.equal(shortModelName(DS), "DeepSeek V4.1 Flash 1017");
	assert.equal(shortModelName(MM), "MiniMax M3.1 Flash");
	assert.equal(
		assignmentSummary([DS, MM], 6),
		"1/3/5号 → DeepSeek V4.1 Flash 1017；2/4/6号 → MiniMax M3.1 Flash",
	);
});

test("Command Code 双模型完整可用时提供组合，并优先于 Paratera", () => {
	const [deepseek, minimax] = COMMANDCODE_SPECS;
	assert.equal(buildModelSets([deepseek]).length, 0);
	assert.equal(buildModelSets([deepseek, MM]).length, 0);
	const sets = buildModelSets([DS, MM, deepseek, minimax]);
	assert.equal(sets.length, 2);
	assert.deepEqual(sets[0]!.specs, [deepseek, minimax]);
	assert.equal(sets[0]!.id, `${deepseek},${minimax}`);
	assert.deepEqual(sets[1]!.specs, [DS, MM]);
	assert.equal(shortModelName(deepseek), "DeepSeek V4.1 Flash");
	assert.equal(shortModelName(minimax), "MiniMax M3.1 Flash");
});
