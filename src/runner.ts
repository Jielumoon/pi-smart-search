// smart-search CLI 调用层：拼参数、spawn、杀进程树、解析 JSON、错误契约
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, win32 } from "node:path";

export const DEFAULT_TIMEOUT_MS = 600_000;
export const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
export const SUPPORTED_VERSION_RANGE = ">=0.1.25 <0.2.0";
const MIN_VERSION = [0, 1, 25];
const MAX_VERSION_EXCLUSIVE = [0, 2, 0];
const KILL_GRACE_MS = 3_000;
const STDERR_TAIL_CHARS = 4_000;
const WRAPPER_SCRIPT = join("node_modules", "@konbakuyomu", "smart-search", "npm", "bin", "smart-search.js");

// 退出码约定见上游 skills/smart-search-cli/references/cli-core.md「Exit Codes」；只在 JSON 没给 error_type 时兜底
const EXIT_CODE_TYPES: Record<number, string> = {
	2: "parameter_error",
	3: "config_error",
	4: "network_error",
	5: "runtime_error",
};

const HINTS: Record<string, string> = {
	config_error:
		"Configure the provider with `smart-search setup` or `smart-search config set <KEY> <value>`, then check `smart-search doctor`.",
	auth_error: "Check the provider API key in the Smart Search config (`smart-search doctor`).",
	rate_limited: "The provider is rate limited; retry later.",
	cli_not_found:
		"Install it with `npm i -g @konbakuyomu/smart-search` (Node 18+), or set PI_SMART_SEARCH_BIN to the executable.",
};

export class SmartSearchError extends Error {
	readonly type: string;
	readonly hint?: string;
	readonly attempts?: string;
	/** CLI 返回了 ok:false 的 JSON 时附带原始结果（doctor 这类诊断命令需要它） */
	readonly data?: Record<string, unknown>;

	constructor(type: string, message: string, attempts?: string, data?: Record<string, unknown>) {
		const hint = HINTS[type];
		super([`[${type}] ${message}`, hint && `Hint: ${hint}`, attempts && `Attempts: ${attempts}`].filter(Boolean).join("\n"));
		this.name = "SmartSearchError";
		this.type = type;
		this.hint = hint;
		this.attempts = attempts;
		this.data = data;
	}
}

export type OptionValue = string | number | boolean | readonly string[] | undefined;

export interface CliCall {
	/** 子命令，如 ["search"]、["providers", "status"] */
	command: readonly string[];
	/** 键是不带 -- 的 CLI 选项名，如 "include-domains" */
	options?: Record<string, OptionValue>;
	positionals?: readonly string[];
}

export interface RunOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	maxOutputBytes?: number;
	killGraceMs?: number;
}

export interface RunResult {
	data: Record<string, unknown>;
	elapsedMs: number;
	exitCode: number | null;
}

function checkArg(value: string, label: string): string {
	if (value.includes("\0")) throw new SmartSearchError("invalid_input", `${label} must not contain NUL bytes.`);
	return value;
}

// 顺序固定为 <命令> <选项...> --format=json [-- <位置参数...>]：
// - 标量选项用 --name=value，值以 - 开头也不会被当成选项
// - 位置参数放在 -- 之后，否则可选位置参数里的 "--output=/path" 会被 argparse 当成选项去写文件
// - 没有位置参数时不能带 --，argparse 会报 unrecognized arguments
export function buildArgs({ command, options = {}, positionals = [] }: CliCall): string[] {
	const args = [...command];
	for (const [name, value] of Object.entries(options)) {
		if (value === undefined || value === false) continue;
		if (value === true) {
			args.push(`--${name}`);
		} else if (Array.isArray(value)) {
			if (value.length === 0) continue;
			// nargs="+" 只能用空格写法，以 - 开头的值会被解析成新选项
			for (const item of value) {
				if (checkArg(item, `--${name}`).startsWith("-")) {
					throw new SmartSearchError("invalid_input", `--${name} values must not start with "-": ${item}`);
				}
			}
			args.push(`--${name}`, ...value);
		} else {
			args.push(`--${name}=${checkArg(String(value), `--${name}`)}`);
		}
	}
	args.push("--format=json");
	if (positionals.length > 0) {
		for (const item of positionals) {
			// Python 3.13 的 argparse 遇到第二个单独的 -- 会解析失败
			if (checkArg(item, "positional argument") === "--") {
				throw new SmartSearchError("invalid_input", 'A positional argument must not be exactly "--".');
			}
		}
		args.push("--", ...positionals);
	}
	return args;
}

export interface CliCommand {
	file: string;
	prefixArgs: string[];
}

// Windows 上不带路径的名字会先在当前目录里找（libuv），恶意仓库放一个同名 exe 就会被执行，所以只在 PATH 的绝对路径里找
function pathDirs(env: NodeJS.ProcessEnv): string[] {
	return (env.PATH ?? env.Path ?? "").split(delimiter).filter((dir) => isAbsolute(dir));
}

function findInPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
	for (const dir of pathDirs(env)) {
		const file = join(dir, name);
		if (existsSync(file)) return file;
	}
	return undefined;
}

// pi 可能以 Bun 编译的单文件二进制运行，这时 process.execPath 是 pi 本身，不能拿来跑 .js
function scriptRuntime(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
	if (/^(node|bun)(\.exe)?$/i.test(basename(process.execPath))) return process.execPath;
	if (platform !== "win32") return "node";
	const node = findInPath("node.exe", env);
	if (!node) throw new SmartSearchError("cli_not_found", "node.exe was not found in PATH; it is needed to run the Smart Search npm wrapper.");
	return node;
}

export function resolveCli(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): CliCommand {
	const bin = env.PI_SMART_SEARCH_BIN?.trim() || "smart-search";
	if (/\.[cm]?js$/i.test(bin)) return { file: scriptRuntime(env, platform), prefixArgs: [bin] };
	if (platform !== "win32") return { file: bin, prefixArgs: [] };
	const hasDir = /[\\/]/.test(bin);
	if (hasDir && /\.exe$/i.test(bin)) return { file: bin, prefixArgs: [] };
	// Windows：npm 全局装的是 .cmd 包装，spawn 它需要 shell 和引号转义；改用 node 直接跑包装脚本
	for (const dir of hasDir ? [dirname(bin)] : pathDirs(env)) {
		const script = join(dir, WRAPPER_SCRIPT);
		if (existsSync(script)) return { file: scriptRuntime(env, platform), prefixArgs: [script] };
		const exe = join(dir, /\.exe$/i.test(bin) ? bin : `${bin}.exe`);
		if (!hasDir && existsSync(exe)) return { file: exe, prefixArgs: [] };
	}
	throw new SmartSearchError("cli_not_found", `Could not find ${bin} (npm wrapper script or .exe) in PATH.`);
}

// setTimeout 超过 2^31-1 会溢出成 1ms，导致每次调用立刻超时
const MAX_TIMER_MS = 2_147_483_647;

function timeoutFromEnv(): number {
	const value = Number(process.env.PI_SMART_SEARCH_TIMEOUT_MS);
	return Number.isInteger(value) && value > 0 && value <= MAX_TIMER_MS ? value : DEFAULT_TIMEOUT_MS;
}

function taskkill(pid: number): string[] {
	return ["/pid", String(pid), "/t", "/f"];
}

// 与 pi 自己的做法一致（shell.js）：用 System32 下的绝对路径，不依赖 PATH 和当前目录
function taskkillPath(): string {
	return win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
}

// POSIX 下子进程是进程组组长（detached），信号发给整个组；npm 包装脚本转发不了 SIGKILL，只杀包装会留下孤儿
function killTree(child: ChildProcess, graceMs: number): void {
	const pid = child.pid;
	if (!pid) return;
	if (process.platform === "win32") {
		spawn(taskkillPath(), taskkill(pid), { stdio: "ignore", windowsHide: true }).once("error", () => child.kill());
		return;
	}
	const signalGroup = (signal: NodeJS.Signals) => {
		try {
			process.kill(-pid, signal);
		} catch {
			// 进程组已经退出
		}
	};
	signalGroup("SIGTERM");
	setTimeout(() => signalGroup("SIGKILL"), graceMs).unref();
}

// detached 的子进程收不到终端发给前台进程组的信号，pi 退出时要主动清掉，否则 CLI 会继续跑、继续消耗 API。
// 只能覆盖会触发 exit 事件的退出（正常退出、process.exit、未捕获异常）；被 SIGINT/SIGKILL 直接终止时无能为力
const activeChildren = new Set<number>();
let exitHookInstalled = false;

function trackChild(pid: number): void {
	activeChildren.add(pid);
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.once("exit", () => {
		for (const active of activeChildren) {
			try {
				if (process.platform === "win32") spawnSync(taskkillPath(), taskkill(active), { stdio: "ignore", windowsHide: true });
				else process.kill(-active, "SIGKILL");
			} catch {
				// 已经退出
			}
		}
	});
}

interface RawOutput {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	elapsedMs: number;
}

function spawnCli(args: string[], options: RunOptions): Promise<RawOutput> {
	const { signal } = options;
	const timeoutMs = options.timeoutMs ?? timeoutFromEnv();
	const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
	const graceMs = options.killGraceMs ?? KILL_GRACE_MS;
	const { file, prefixArgs } = resolveCli();
	const started = Date.now();

	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new SmartSearchError("cancelled", "The Smart Search call was cancelled."));
			return;
		}
		const child = spawn(file, [...prefixArgs, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		if (child.pid) trackChild(child.pid);
		const chunks: Buffer[] = [];
		let outputBytes = 0;
		let stderr = "";
		let failure: SmartSearchError | undefined;
		let settled = false;

		const stop = (error: SmartSearchError) => {
			if (failure) return;
			failure = error;
			killTree(child, graceMs);
			// 兜底：进程树没杀干净（孙进程还占着管道，close 不会触发）时也要按时结束，不能让工具调用永远挂住
			setTimeout(() => {
				child.stdout?.destroy();
				child.stderr?.destroy();
				finish(() => reject(error));
			}, graceMs + 1_000).unref();
		};
		const onAbort = () => stop(new SmartSearchError("cancelled", "The Smart Search call was cancelled."));
		const timer = setTimeout(
			() =>
				stop(
					new SmartSearchError(
						"timeout",
						`Smart Search exceeded the ${timeoutMs} ms hard timeout (adjust with PI_SMART_SEARCH_TIMEOUT_MS).`,
					),
				),
			timeoutMs,
		);
		const finish = (settle: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (child.pid) activeChildren.delete(child.pid);
			settle();
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout!.on("data", (chunk: Buffer) => {
			outputBytes += chunk.length;
			if (outputBytes > maxOutputBytes) {
				stop(new SmartSearchError("output_too_large", `Smart Search wrote more than ${maxOutputBytes} bytes to stdout.`));
			} else if (!failure) {
				chunks.push(chunk);
			}
		});
		child.stderr!.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
		});
		child.once("error", (error: NodeJS.ErrnoException) => {
			killTree(child, graceMs);
			const detail = error.code ? `${error.code}: ${error.message}` : error.message;
			finish(() => reject(new SmartSearchError("cli_not_found", `Unable to start the Smart Search CLI (${file}). ${detail}`)));
		});
		child.once("close", (exitCode) => {
			finish(() => {
				if (failure) reject(failure);
				else resolve({ stdout: Buffer.concat(chunks).toString("utf8"), stderr, exitCode, elapsedMs: Date.now() - started });
			});
		});
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function summarizeAttempts(value: unknown): string | undefined {
	if (!Array.isArray(value)) return undefined;
	const parts = value.filter(isRecord).map((attempt) => {
		const errorType = text(attempt.error_type);
		return `${text(attempt.provider) || "?"} ${text(attempt.status) || "?"}${errorType ? `(${errorType})` : ""}`;
	});
	return parts.length > 0 ? parts.join(", ") : undefined;
}

// 成败以 JSON 的 ok 字段为准；error_type 原样透传（上游是开放集合，还在增加）
export function parseResult(stdout: string, stderr: string, exitCode: number | null): Record<string, unknown> {
	let data: unknown;
	try {
		data = JSON.parse(stdout);
	} catch {
		data = undefined;
	}
	if (!isRecord(data) || typeof data.ok !== "boolean") {
		// 例如 argparse 报错：stdout 为空，错误只写在 stderr
		const detail = stderr.trim().slice(-1_000) || stdout.trim().slice(0, 500);
		throw new SmartSearchError(
			"invalid_output",
			`Smart Search exited with code ${exitCode} without a JSON result.${detail ? `\n${detail}` : ""}`,
		);
	}
	if (data.ok) return data;
	const type = text(data.error_type) || (exitCode !== null && EXIT_CODE_TYPES[exitCode]) || "unknown_error";
	const message = text(data.error) || `Smart Search reported ok:false (exit code ${exitCode}).`;
	throw new SmartSearchError(type, message, summarizeAttempts(data.provider_attempts), data);
}

export async function runSmartSearch(call: CliCall, options: RunOptions = {}): Promise<RunResult> {
	const args = buildArgs(call);
	const { stdout, stderr, exitCode, elapsedMs } = await spawnCli(args, options);
	return { data: parseResult(stdout, stderr, exitCode), elapsedMs, exitCode };
}

export interface CliStatus {
	state: "ok" | "missing" | "unsupported" | "unknown";
	version?: string;
	message: string;
}

function compareVersion(a: number[], b: number[]): number {
	for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
	return 0;
}

// 超出兼容范围只警告不拒绝
export async function checkCliVersion(options: RunOptions = {}): Promise<CliStatus> {
	let output: RawOutput;
	try {
		output = await spawnCli(["--version"], { timeoutMs: 15_000, ...options });
	} catch (error) {
		if (error instanceof SmartSearchError && error.type === "cli_not_found") return { state: "missing", message: error.message };
		return { state: "unknown", message: error instanceof Error ? error.message : String(error) };
	}
	const match = /(\d+)\.(\d+)\.(\d+)/.exec(output.stdout);
	if (output.exitCode !== 0 || !match) {
		const detail = (output.stdout || output.stderr).trim().slice(0, 200);
		return { state: "unknown", message: `Unexpected \`smart-search --version\` output (exit ${output.exitCode}): ${detail}` };
	}
	const version = match.slice(1).map(Number);
	const label = match[0];
	if (compareVersion(version, MIN_VERSION) < 0 || compareVersion(version, MAX_VERSION_EXCLUSIVE) >= 0) {
		return {
			state: "unsupported",
			version: label,
			message: `smart-search ${label} is outside the tested range ${SUPPORTED_VERSION_RANGE}; tools still run, but output fields may differ.`,
		};
	}
	return { state: "ok", version: label, message: `smart-search ${label}` };
}
