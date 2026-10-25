export type Args = {
	values: Map<string, string | boolean>;
	positionals: string[];
};

export function parseArgs(argv: string[]): Args {
	const values = new Map<string, string | boolean>();
	const positionals: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--") {
			positionals.push(...argv.slice(i + 1));
			break;
		}
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			if (eq > 2) {
				values.set(arg.slice(2, eq), arg.slice(eq + 1));
				continue;
			}
			const key = arg.slice(2);
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("-")) {
				values.set(key, next);
				i += 1;
			} else {
				values.set(key, true);
			}
			continue;
		}
		if (arg.startsWith("-") && arg !== "-") {
			values.set(arg.slice(1), true);
			continue;
		}
		positionals.push(arg);
	}
	return { values, positionals };
}

export function stringArg(args: Args, key: string, fallback?: string): string | undefined {
	const value = args.values.get(key);
	return typeof value === "string" ? value : fallback;
}

export function boolArg(args: Args, key: string): boolean {
	return args.values.get(key) === true || args.values.get(key) === "true";
}

export function numberArg(args: Args, key: string, fallback: number): number {
	const value = stringArg(args, key);
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) throw new Error(`--${key} 需要数字，收到 ${value}`);
	return parsed;
}
