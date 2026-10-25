/**
 * CLI 收尾：pi 的 ModelRuntime / provider 可能保留 keep-alive socket 或内部 timer，
 * 游戏结束后事件循环不会自己空。这里等 stdout 刷出后主动退出。
 */
export function exitAfterFlush(): void {
	const code = process.exitCode ?? 0;
	let finished = false;
	const finish = () => {
		if (finished) return;
		finished = true;
		process.exit(code);
	};
	const timer = setTimeout(finish, 500);
	process.stdout.write("", () => {
		clearTimeout(timer);
		finish();
	});
}
