import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { describeAvailableModels } from "../agents/model.ts";
import { boolArg, parseArgs, stringArg } from "./args.ts";
import { exitAfterFlush } from "./exit.ts";

const HELP = `用法：node src/cli/doctor.ts [选项]

  --live           用真实模型跑一次最小 agent 回合（会产生少量 token）
  --model <id>     --live 时指定模型
  --thinking <l>   --live 时的 thinking level
  --help           显示帮助`;

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (boolArg(args, "help")) {
		console.log(HELP);
		return;
	}
	console.log(`Node：${process.version}`);
	console.log(`平台：${process.platform} ${process.arch}`);
	console.log(`pi agent dir：${getAgentDir()}`);
	console.log("");
	let models: string[] = [];
	try {
		models = await describeAvailableModels();
	} catch (error) {
		console.error(`读取模型失败：${error instanceof Error ? error.message : String(error)}`);
	}
	if (models.length === 0) {
		console.log("可用模型：无");
		console.log("请先运行 `pi auth` 登录，或设置对应 provider 的 API key。");
	} else {
		console.log(`可用模型（${models.length}）：`);
		for (const model of models) console.log(`  - ${model}`);
	}

	if (boolArg(args, "live")) {
		if (models.length === 0) {
			console.error("\n没有可用模型，无法执行 --live。");
			process.exitCode = 1;
			return;
		}
		const { runSmoke } = await import("../agents/smoke-lib.ts");
		console.log("\n运行 live smoke ...");
		try {
			const result = await runSmoke({
				model: stringArg(args, "model"),
				thinkingLevel: stringArg(args, "thinking", "low"),
				onTool: (name, ok) => console.log(`  工具 ${name} ${ok ? "✓" : "✗"}`),
			});
			console.log(`模型：${result.model}`);
			console.log(`发言：${result.speech}`);
			console.log(`用量：${result.usage.total} tokens（输入 ${result.usage.input} / 输出 ${result.usage.output}）`);
			console.log("live smoke：通过");
		} catch (error) {
			console.error(`live smoke：失败 —— ${error instanceof Error ? error.message : String(error)}`);
			console.error("可用 --model 指定其他模型。");
			process.exitCode = 1;
		}
	}
}

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
exitAfterFlush();
