import { boolArg, parseArgs, stringArg } from "./args.ts";
import { exitAfterFlush } from "./exit.ts";
import { runSmoke } from "../agents/smoke-lib.ts";

const HELP = `用法：node src/cli/smoke.ts [选项]

  --model <provider/id>  指定模型，例如 openai-codex/gpt-5.6-luna
  --thinking <level>     thinking level，默认 low
  --help                 显示帮助`;

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (boolArg(args, "help")) {
		console.log(HELP);
		return;
	}
	console.log("正在用真实模型执行一次最小 agent 回合 ...");
	try {
		const result = await runSmoke({
			model: stringArg(args, "model"),
			thinkingLevel: stringArg(args, "thinking", "low"),
			onTool: (name, ok) => console.log(`  工具 ${name} ${ok ? "✓" : "✗"}`),
		});
		console.log(`模型：${result.model}`);
		console.log(`工具调用：${result.toolCalls.join(", ") || "无"}`);
		console.log(`发言：${result.speech}`);
		console.log(`用量：${result.usage.total} tokens（输入 ${result.usage.input} / 输出 ${result.usage.output}）`);
		console.log("冒烟测试：通过");
	} catch (error) {
		console.error(`冒烟测试：失败 —— ${error instanceof Error ? error.message : String(error)}`);
		console.error("如果提示 model not supported，请用 --model 指定账号可用的模型。");
		process.exitCode = 1;
	}
}

try {
	await main();
} catch (error) {
	console.error(`冒烟测试：失败 —— ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
exitAfterFlush();
