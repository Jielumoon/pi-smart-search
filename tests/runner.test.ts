import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
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
import { FAKE_CLI, fake, fixture, useFakeCli } from "./helpers.ts";

const workDir = useFakeCli();

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

	it("成败以 ok 字段为准，不看退出码", async () => {
		fake("stdout", { FAKE_SMART_SEARCH_STDOUT: '{"ok":true,"content":"x"}', FAKE_SMART_SEARCH_EXIT: "1" });
		expect((await runSmartSearch({ command: ["search"], positionals: ["q"] })).data.content).toBe("x");
		fake("stdout", { FAKE_SMART_SEARCH_STDOUT: '{"ok":false,"error_type":"quality_error","error":"weak"}', FAKE_SMART_SEARCH_EXIT: "0" });
		await expectFailure({ command: ["search"], positionals: ["q"] }, "quality_error");
	});

	it("stderr 只保留尾部，argparse 的最后一行错误不会被截掉", async () => {
		fake("stdout", { FAKE_SMART_SEARCH_STDERR: `${"x".repeat(5000)}\nFINAL ERROR LINE`, FAKE_SMART_SEARCH_EXIT: "2" });
		const error = await expectFailure({ command: ["search"], positionals: ["q"] }, "invalid_output");
		expect(error.message).toContain("FINAL ERROR LINE");
	});

	it.each(["0", "-1", "abc", "1.5", "3000000000"])("PI_SMART_SEARCH_TIMEOUT_MS=%s 非法时回落到默认值", async (value) => {
		process.env.PI_SMART_SEARCH_TIMEOUT_MS = value;
		fake("echo");
		expect((await runSmartSearch({ command: ["route"], positionals: ["q"] })).data.ok).toBe(true);
	});

	it("找不到 CLI 时报 cli_not_found 并给出安装提示", async () => {
		process.env.PI_SMART_SEARCH_BIN = join(workDir(), "missing-smart-search");
		const error = await expectFailure({ command: ["search"], positionals: ["q"] }, "cli_not_found");
		expect(error.message).toContain("ENOENT");
		expect(error.message).toContain("Hint: Install it with `npm i -g @konbakuyomu/smart-search`");
	});
});

describe("超时与中止", () => {
	// 负载下假 CLI 启动可达 ~450ms：硬超时要留足余量，否则会在 pid 文件写出前就超时
	const TIMEOUT_MS = 2_000;
	const HANG_TEST_MS = 15_000;
	let escapedPid: number | undefined;

	afterEach(() => {
		if (escapedPid && isAlive(escapedPid)) process.kill(escapedPid, "SIGKILL");
		escapedPid = undefined;
	});

	async function expectTreeDead(pidFile: string): Promise<void> {
		for (const pid of hangPids(pidFile)) await waitFor(() => !isAlive(pid));
	}

	it(
		"硬超时后杀掉整个进程组（包括继承 stdout 的孙进程）",
		async () => {
			const pidFile = join(workDir(), "pids");
			fake("hang", { FAKE_SMART_SEARCH_PIDFILE: pidFile });
			const error = await expectFailure({ command: ["search"], positionals: ["q"] }, "timeout", { timeoutMs: TIMEOUT_MS });
			expect(error.message).toContain("PI_SMART_SEARCH_TIMEOUT_MS");
			await expectTreeDead(pidFile);
		},
		HANG_TEST_MS,
	);

	it(
		"PI_SMART_SEARCH_TIMEOUT_MS 覆盖默认硬超时",
		async () => {
			process.env.PI_SMART_SEARCH_TIMEOUT_MS = String(TIMEOUT_MS);
			fake("hang", { FAKE_SMART_SEARCH_PIDFILE: join(workDir(), "pids") });
			await expectFailure({ command: ["search"], positionals: ["q"] }, "timeout");
		},
		HANG_TEST_MS,
	);

	it(
		"AbortSignal 触发后报 cancelled，并杀掉进程树",
		async () => {
			const pidFile = join(workDir(), "pids");
			fake("hang", { FAKE_SMART_SEARCH_PIDFILE: pidFile });
			const controller = new AbortController();
			const pending = expectFailure({ command: ["search"], positionals: ["q"] }, "cancelled", { signal: controller.signal });
			await waitFor(() => existsSync(pidFile));
			controller.abort();
			await pending;
			await expectTreeDead(pidFile);
		},
		HANG_TEST_MS,
	);

	it("调用前已中止时直接报 cancelled，不启动 CLI", async () => {
		const pidFile = join(workDir(), "pids");
		fake("hang", { FAKE_SMART_SEARCH_PIDFILE: pidFile });
		await expectFailure({ command: ["search"], positionals: ["q"] }, "cancelled", { signal: AbortSignal.abort() });
		expect(existsSync(pidFile)).toBe(false);
	});

	it(
		"进程忽略 SIGTERM 时，宽限期后用 SIGKILL 杀掉（在兜底返回之前就结束）",
		async () => {
			const pidFile = join(workDir(), "pids");
			fake("hang", { FAKE_SMART_SEARCH_PIDFILE: pidFile, FAKE_SMART_SEARCH_IGNORE_TERM: "1" });
			const controller = new AbortController();
			const started = Date.now();
			const pending = expectFailure({ command: ["search"], positionals: ["q"] }, "cancelled", {
				signal: controller.signal,
				killGraceMs: 300,
			});
			await waitFor(() => existsSync(pidFile));
			const [fakePid] = hangPids(pidFile);
			const abortedAt = Date.now();
			controller.abort();
			// 没有 SIGKILL 的话，忽略 SIGTERM 的假 CLI 会一直活着
			await waitFor(() => !isAlive(fakePid), 3_000);
			expect(Date.now() - abortedAt).toBeGreaterThanOrEqual(300);
			await pending;
			expect(Date.now() - started).toBeLessThan(HANG_TEST_MS);
		},
		HANG_TEST_MS,
	);

	it(
		"孙进程逃出进程组、一直占着管道时，也会在宽限期后按时返回",
		async () => {
			const pidFile = join(workDir(), "pids");
			fake("hang", { FAKE_SMART_SEARCH_PIDFILE: pidFile, FAKE_SMART_SEARCH_ESCAPE: "1" });
			const controller = new AbortController();
			const pending = expectFailure({ command: ["search"], positionals: ["q"] }, "cancelled", {
				signal: controller.signal,
				killGraceMs: 200,
			});
			await waitFor(() => existsSync(pidFile));
			escapedPid = hangPids(pidFile)[1];
			const abortedAt = Date.now();
			controller.abort();
			await pending;
			// 兜底在宽限期 + 1s 后触发
			expect(Date.now() - abortedAt).toBeLessThan(200 + 1_000 + 2_000);
		},
		HANG_TEST_MS,
	);

	it(
		"宿主进程退出时清掉仍在运行的 CLI 进程组",
		async () => {
			const pidFile = join(workDir(), "pids");
			const runner = join(import.meta.dirname, "..", "src", "runner.ts");
			// 在独立的 node 进程里发起调用，等 CLI 起来后直接 process.exit，模拟 pi 退出
			const script = `
				import { existsSync } from "node:fs";
				import { runSmartSearch } from ${JSON.stringify(runner)};
				runSmartSearch({ command: ["search"], positionals: ["q"] }).catch(() => {});
				const timer = setInterval(() => { if (existsSync(${JSON.stringify(pidFile)})) { clearInterval(timer); process.exit(0); } }, 20);
			`;
			fake("hang", { FAKE_SMART_SEARCH_PIDFILE: pidFile });
			const host = spawnSync(process.execPath, ["--input-type=module", "--no-warnings", "-e", script], { env: process.env, timeout: 10_000 });
			expect(host.status).toBe(0);
			await expectTreeDead(pidFile);
		},
		HANG_TEST_MS,
	);
});

describe("resolveCli", () => {
	function makeWindowsPrefix(): string {
		const prefix = join(workDir(), "npm");
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

	it("Windows 指定 .exe 绝对路径时直接执行", () => {
		expect(resolveCli({ PI_SMART_SEARCH_BIN: "C:/bin/smart-search.exe" }, "win32")).toEqual({
			file: "C:/bin/smart-search.exe",
			prefixArgs: [],
		});
	});

	it("Windows 只接受 PATH 里的绝对路径，不回落到裸名（否则会先执行当前目录下的同名 exe）", () => {
		const bin = join(workDir(), "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "smart-search.exe"), "");
		expect(resolveCli({ PATH: ["relative-dir", bin].join(delimiter) }, "win32")).toEqual({
			file: join(bin, "smart-search.exe"),
			prefixArgs: [],
		});
		expect(() => resolveCli({ PATH: workDir() }, "win32")).toThrow(/cli_not_found/);
		expect(() => resolveCli({ PATH: "." }, "win32")).toThrow(/cli_not_found/);
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
		process.env.PI_SMART_SEARCH_BIN = join(workDir(), "missing-smart-search");
		expect((await checkCliVersion()).state).toBe("missing");
	});
});

// 真实 CLI 回归：PI_SMART_SEARCH_IT=1 时才跑（需要已安装 smart-search）
describe.runIf(process.env.PI_SMART_SEARCH_IT === "1")("真实 smart-search CLI", () => {
	beforeEach(() => {
		delete process.env.PI_SMART_SEARCH_BIN;
	});

	it("可选位置参数里的 --output=... 不会被当成选项去写文件", async () => {
		const target = join(workDir(), "injected.txt");
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
