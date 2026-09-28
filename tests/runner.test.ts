import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildArgs,
	checkCliVersion,
	resolveCli,
	runSmartSearch,
	SmartSearchError,
	type CliCall,
	type RunOptions,
} from "../src/runner.ts";

const FAKE_CLI = join(import.meta.dirname, "fake-smart-search.mjs");
const FIXTURES = join(import.meta.dirname, "fixtures");
const ENV_PREFIXES = ["PI_SMART_SEARCH_", "FAKE_SMART_SEARCH_"];

let savedEnv: Record<string, string | undefined>;
let workDir: string;

beforeEach(() => {
	savedEnv = Object.fromEntries(
		Object.keys(process.env)
			.filter((key) => ENV_PREFIXES.some((prefix) => key.startsWith(prefix)))
			.map((key) => [key, process.env[key]]),
	);
	for (const key of Object.keys(savedEnv)) delete process.env[key];
	process.env.PI_SMART_SEARCH_BIN = FAKE_CLI;
	workDir = mkdtempSync(join(tmpdir(), "pi-smart-search-test-"));
});

afterEach(() => {
	for (const key of Object.keys(process.env)) {
		if (ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) delete process.env[key];
	}
	Object.assign(process.env, savedEnv);
	rmSync(workDir, { recursive: true, force: true });
});

function fake(mode: string, extra: Record<string, string> = {}): void {
	Object.assign(process.env, { FAKE_SMART_SEARCH_MODE: mode, ...extra });
}

function fixture(name: string): string {
	return readFileSync(join(FIXTURES, name), "utf8");
}

async function expectFailure(call: CliCall, type: string, options?: RunOptions): Promise<SmartSearchError> {
	const error = await runSmartSearch(call, options).then(
		() => undefined,
		(reason: unknown) => reason,
	);
	expect(error).toBeInstanceOf(SmartSearchError);
	expect((error as SmartSearchError).type).toBe(type);
	return error as SmartSearchError;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function hangPids(pidFile: string): number[] {
	return readFileSync(pidFile, "utf8").trim().split(" ").map(Number);
}

describe("buildArgs", () => {
	it("选项在前、--format=json 居中、位置参数放在 -- 之后", () => {
		expect(
			buildArgs({
				command: ["exa-search"],
				options: {
					"num-results": 3,
					"include-domains": ["a.com", "b.com"],
					"include-highlights": true,
					"include-text": false,
					category: undefined,
					"exclude-domains": [],
				},
				positionals: ["--output=/tmp/x"],
			}),
		).toEqual([
			"exa-search",
			"--num-results=3",
			"--include-domains",
			"a.com",
			"b.com",
			"--include-highlights",
			"--format=json",
			"--",
			"--output=/tmp/x",
		]);
	});

	it("没有位置参数时不加 --（argparse 会报 unrecognized arguments）", () => {
		expect(buildArgs({ command: ["providers", "status"] })).toEqual(["providers", "status", "--format=json"]);
	});

	it("标量选项用 = 写法，以 - 开头的值也安全", () => {
		expect(buildArgs({ command: ["route"], options: { validation: "-x" }, positionals: ["q"] })).toContain("--validation=-x");
	});

	it.each([
		["数组值以 - 开头", { command: ["exa-search"], options: { "include-domains": ["a.com", "--output=/x"] } }],
		["位置参数恰好是 --", { command: ["search"], positionals: ["--"] }],
		["含 NUL", { command: ["search"], positionals: ["a\0b"] }],
		["选项值含 NUL", { command: ["search"], options: { platform: "a\0b" }, positionals: ["q"] }],
	] satisfies [string, CliCall][])("拒绝不安全的参数：%s", (_name, call) => {
		expect(() => buildArgs(call)).toThrow(SmartSearchError);
		try {
			buildArgs(call);
		} catch (error) {
			expect((error as SmartSearchError).type).toBe("invalid_input");
		}
	});
});

describe("runSmartSearch", () => {
	it("CLI 收到的 argv 与 buildArgs 完全一致", async () => {
		fake("echo");
		const call: CliCall = { command: ["context7-library"], positionals: ["react", "--output=/tmp/should-not-exist"] };
		const result = await runSmartSearch(call);
		expect(result.data.argv).toEqual(buildArgs(call));
		expect(result.exitCode).toBe(0);
		expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
	});

	it("ok:true 时返回解析后的 JSON", async () => {
		fake("stdout", { FAKE_SMART_SEARCH_STDOUT: fixture("search.ok.json") });
		const { data } = await runSmartSearch({ command: ["search"], positionals: ["q"] });
		expect(data.provider).toBe("xai-responses");
		expect(data.sources).toHaveLength(4);
	});

	it("ok:false 时透传 error_type，并附上 provider 尝试记录", async () => {
		fake("stdout", { FAKE_SMART_SEARCH_STDOUT: fixture("fetch.parameter_error.json"), FAKE_SMART_SEARCH_EXIT: "2" });
		const error = await expectFailure({ command: ["fetch"], positionals: ["not-a-url"] }, "parameter_error");
		expect(error.message).toMatch(/^\[parameter_error\] HTTP 400/);
		expect(error.attempts).toBe("tavily error(parameter_error), firecrawl error(parameter_error)");
		expect(error.hint).toBeUndefined();
	});

	it("config_error 带修复提示", async () => {
		fake("stdout", { FAKE_SMART_SEARCH_STDOUT: fixture("doctor.config_error.json"), FAKE_SMART_SEARCH_EXIT: "3" });
		const error = await expectFailure({ command: ["doctor"] }, "config_error");
		expect(error.message).toContain("\nHint: Configure the provider");
	});

	it("error_type 未知的新类型也原样透传", async () => {
		fake("stdout", { FAKE_SMART_SEARCH_STDOUT: '{"ok":false,"error_type":"quality_error","error":"weak evidence"}', FAKE_SMART_SEARCH_EXIT: "4" });
		const error = await expectFailure({ command: ["search"], positionals: ["q"] }, "quality_error");
		expect(error.message).toBe("[quality_error] weak evidence");
	});

	it.each([
		["4", "network_error"],
		["9", "unknown_error"],
	])("缺少 error_type 时按退出码 %s 兜底为 %s", async (exitCode, type) => {
		fake("stdout", { FAKE_SMART_SEARCH_STDOUT: '{"ok":false}', FAKE_SMART_SEARCH_EXIT: exitCode });
		await expectFailure({ command: ["search"], positionals: ["q"] }, type);
	});

	it("argparse 报错（stdout 为空）时从 stderr 取错误信息", async () => {
		fake("stdout", { FAKE_SMART_SEARCH_STDERR: fixture("research.argparse_error.stderr.txt"), FAKE_SMART_SEARCH_EXIT: "2" });
		const error = await expectFailure({ command: ["research"], positionals: ["x"] }, "invalid_output");
		expect(error.message).toContain("exited with code 2");
		expect(error.message).toContain("invalid choice: 'nope'");
	});

	it.each([
		["帮助文本", "usage: smart-search route [-h]"],
		["缺少 ok 字段的 JSON", '{"content":"x"}'],
		["JSON 数组", "[]"],
	])("stdout 不是合法结果（%s）时报 invalid_output", async (_name, stdout) => {
		fake("stdout", { FAKE_SMART_SEARCH_STDOUT: stdout });
		await expectFailure({ command: ["route"], positionals: ["q"] }, "invalid_output");
	});

	it("stdout 超过上限时报 output_too_large", async () => {
		fake("big", { FAKE_SMART_SEARCH_BYTES: "20000" });
		await expectFailure({ command: ["research"], positionals: ["q"] }, "output_too_large", { maxOutputBytes: 1024 });
	});

	it("找不到 CLI 时报 cli_not_found 并给出安装提示", async () => {
		process.env.PI_SMART_SEARCH_BIN = join(workDir, "missing-smart-search");
		const error = await expectFailure({ command: ["search"], positionals: ["q"] }, "cli_not_found");
		expect(error.message).toContain("ENOENT");
		expect(error.message).toContain("Hint: Install it with `npm i -g @konbakuyomu/smart-search`");
	});
});

describe("超时与中止", () => {
	it("硬超时后杀掉整个进程组（包括继承 stdout 的孙进程）", async () => {
		const pidFile = join(workDir, "pids");
		fake("hang", { FAKE_SMART_SEARCH_PIDFILE: pidFile });
		const error = await expectFailure({ command: ["search"], positionals: ["q"] }, "timeout", { timeoutMs: 500 });
		expect(error.message).toContain("PI_SMART_SEARCH_TIMEOUT_MS");
		for (const pid of hangPids(pidFile)) await waitFor(() => !isAlive(pid));
	});

	it("PI_SMART_SEARCH_TIMEOUT_MS 覆盖默认硬超时", async () => {
		process.env.PI_SMART_SEARCH_TIMEOUT_MS = "500";
		fake("hang", { FAKE_SMART_SEARCH_PIDFILE: join(workDir, "pids") });
		await expectFailure({ command: ["search"], positionals: ["q"] }, "timeout");
	});

	it("AbortSignal 触发后报 cancelled，并杀掉进程树", async () => {
		const pidFile = join(workDir, "pids");
		fake("hang", { FAKE_SMART_SEARCH_PIDFILE: pidFile });
		const controller = new AbortController();
		const pending = expectFailure({ command: ["search"], positionals: ["q"] }, "cancelled", { signal: controller.signal });
		await waitFor(() => existsSync(pidFile));
		controller.abort();
		await pending;
		for (const pid of hangPids(pidFile)) await waitFor(() => !isAlive(pid));
	});

	it("调用前已中止时直接报 cancelled，不启动 CLI", async () => {
		const pidFile = join(workDir, "pids");
		fake("hang", { FAKE_SMART_SEARCH_PIDFILE: pidFile });
		await expectFailure({ command: ["search"], positionals: ["q"] }, "cancelled", { signal: AbortSignal.abort() });
		expect(existsSync(pidFile)).toBe(false);
	});

	it("进程忽略 SIGTERM 时，宽限期后升级为 SIGKILL", async () => {
		const pidFile = join(workDir, "pids");
		fake("hang", { FAKE_SMART_SEARCH_PIDFILE: pidFile, FAKE_SMART_SEARCH_IGNORE_TERM: "1" });
		const started = Date.now();
		await expectFailure({ command: ["search"], positionals: ["q"] }, "timeout", { timeoutMs: 500, killGraceMs: 300 });
		expect(Date.now() - started).toBeGreaterThanOrEqual(800);
		for (const pid of hangPids(pidFile)) await waitFor(() => !isAlive(pid));
	});

	it("孙进程逃出进程组、一直占着管道时，也会在宽限期后按时返回", async () => {
		const pidFile = join(workDir, "pids");
		fake("hang", { FAKE_SMART_SEARCH_PIDFILE: pidFile, FAKE_SMART_SEARCH_ESCAPE: "1" });
		const started = Date.now();
		try {
			await expectFailure({ command: ["search"], positionals: ["q"] }, "timeout", { timeoutMs: 300, killGraceMs: 200 });
			expect(Date.now() - started).toBeLessThan(5_000);
		} finally {
			const [, escaped] = hangPids(pidFile);
			process.kill(escaped, "SIGKILL");
		}
	});
});

describe("resolveCli", () => {
	function makeWindowsPrefix(): string {
		const prefix = join(workDir, "npm");
		const script = join(prefix, "node_modules", "@konbakuyomu", "smart-search", "npm", "bin", "smart-search.js");
		mkdirSync(dirname(script), { recursive: true });
		writeFileSync(script, "");
		return prefix;
	}

	it("默认直接执行 PATH 上的 smart-search", () => {
		expect(resolveCli({}, "linux")).toEqual({ file: "smart-search", prefixArgs: [] });
	});

	it(".js/.mjs 用 node 执行", () => {
		const { file, prefixArgs } = resolveCli({ PI_SMART_SEARCH_BIN: FAKE_CLI }, "linux");
		expect(basename(file)).toMatch(/^(node|bun)(\.exe)?$/i);
		expect(prefixArgs).toEqual([FAKE_CLI]);
	});

	it("Windows 从 PATH 找到 npm 包装脚本，改用 node 执行", () => {
		const prefix = makeWindowsPrefix();
		const { prefixArgs } = resolveCli({ PATH: prefix }, "win32");
		expect(prefixArgs).toEqual([join(prefix, "node_modules", "@konbakuyomu", "smart-search", "npm", "bin", "smart-search.js")]);
	});

	it("Windows 指定 .cmd 绝对路径时，在同目录找包装脚本", () => {
		const prefix = makeWindowsPrefix();
		const { prefixArgs } = resolveCli({ PI_SMART_SEARCH_BIN: join(prefix, "smart-search.cmd"), PATH: "" }, "win32");
		expect(prefixArgs[0]).toContain(prefix);
	});

	it("Windows 指定 .exe 或找不到包装脚本时直接执行", () => {
		expect(resolveCli({ PI_SMART_SEARCH_BIN: "C:/bin/smart-search.exe" }, "win32")).toEqual({
			file: "C:/bin/smart-search.exe",
			prefixArgs: [],
		});
		expect(resolveCli({ PATH: workDir }, "win32")).toEqual({ file: "smart-search", prefixArgs: [] });
	});
});

describe("checkCliVersion", () => {
	it.each([
		["smart-search 0.1.25\n", "ok"],
		["smart-search 0.1.40\n", "ok"],
		["smart-search 0.1.24\n", "unsupported"],
		["smart-search 0.2.0\n", "unsupported"],
		["garbage\n", "unknown"],
	])("%j → %s", async (stdout, state) => {
		fake("stdout", { FAKE_SMART_SEARCH_STDOUT: stdout });
		const status = await checkCliVersion();
		expect(status.state).toBe(state);
		if (state === "unsupported") expect(status.message).toContain(">=0.1.25 <0.2.0");
	});

	it("没装 CLI 时返回 missing", async () => {
		process.env.PI_SMART_SEARCH_BIN = join(workDir, "missing-smart-search");
		expect((await checkCliVersion()).state).toBe("missing");
	});
});

// 真实 CLI 回归：PI_SMART_SEARCH_IT=1 时才跑（需要已安装 smart-search）
describe.runIf(process.env.PI_SMART_SEARCH_IT === "1")("真实 smart-search CLI", () => {
	beforeEach(() => {
		delete process.env.PI_SMART_SEARCH_BIN;
	});

	it("可选位置参数里的 --output=... 不会被当成选项去写文件", async () => {
		const target = join(workDir, "injected.txt");
		await runSmartSearch({ command: ["context7-library"], positionals: ["react", `--output=${target}`] }).catch(() => undefined);
		expect(existsSync(target)).toBe(false);
	});

	it("以 -- 开头的查询按普通文本处理", async () => {
		const { data } = await runSmartSearch({ command: ["route"], positionals: ["--help"] });
		expect(data.query).toBe("--help");
	});

	it("版本在兼容范围内", async () => {
		expect((await checkCliVersion()).state).toBe("ok");
	});
});
