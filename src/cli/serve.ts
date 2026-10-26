import { spawn } from "node:child_process";
import { boolArg, numberArg, parseArgs, stringArg } from "./args.ts";
import { startSpectatorServer } from "../server/spectator-server.ts";

const HELP = `用法：node src/cli/serve.ts [选项]

  --port <n>        端口（默认 7331）
  --host <addr>     监听地址（默认 127.0.0.1；0.0.0.0 会暴露到局域网）
  --runs <dir>      对局目录（默认 runs）
  --board <9p|12p>  新对局默认板子（默认 9p；12p 含警长竞选与白痴）
  --god             启用上帝视角（默认可切换为上帝视角的按钮隐藏）
  --model <id>      前端“真实模型”表单的默认模型
  --thinking <l>    默认 thinking level（默认 low）
  --max-days <n>    默认最大天数（默认 30）
  --timeout <sec>   单回合模型超时（默认 240）
  --open            启动后尝试打开浏览器
  --help            显示帮助

页面默认是公开视角；只有带 --god 启动，前端才会出现“上帝视角”开关。`;

function openBrowser(url: string): void {
	const command =
		process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	try {
		const child = spawn(command, args, { stdio: "ignore", detached: true });
		child.unref();
	} catch {
		// best effort
	}
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (boolArg(args, "help")) {
		console.log(HELP);
		return;
	}
	const port = numberArg(args, "port", 7331);
	const host = stringArg(args, "host", "127.0.0.1")!;
	const runsDir = stringArg(args, "runs", "runs")!;
	const boardArg = stringArg(args, "board", "9p")!;
	if (boardArg !== "9p" && boardArg !== "12p") {
		throw new Error("--board 必须是 9p 或 12p");
	}
	const board = boardArg;
	const god = boolArg(args, "god");
	const model = stringArg(args, "model");
	const thinking = stringArg(args, "thinking", "low")!;
	const maxDays = numberArg(args, "max-days", 30);
	const timeoutMs = numberArg(args, "timeout", 240) * 1000;

	const { server, url } = await startSpectatorServer({
		runsDir,
		host,
		port,
		godEnabled: god,
		model,
		board,
		thinkingLevel: thinking,
		maxDays,
		timeoutMs,
	});

	console.log(`观战服务：${url}`);
	console.log(`对局目录：${runsDir}`);
	console.log(`上帝视角：${god ? "开启" : "关闭（加 --god 开启）"}`);
	console.log("Ctrl+C 停止");
	if (boolArg(args, "open")) openBrowser(url);

	let closing = false;
	const shutdown = async (signal: string) => {
		if (closing) return;
		closing = true;
		console.log(`\n收到 ${signal}，正在关闭观战服务 ...`);
		try {
			await server.close();
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
		}
		process.exit(0);
	};
	process.once("SIGINT", () => void shutdown("SIGINT"));
	process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
