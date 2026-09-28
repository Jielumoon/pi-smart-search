// 测试公共设置：每个用例隔离 PI_SMART_SEARCH_* / FAKE_SMART_SEARCH_* 环境变量，并默认接上假 CLI
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";

export const FAKE_CLI = join(import.meta.dirname, "fake-smart-search.mjs");
const FIXTURES = join(import.meta.dirname, "fixtures");
const ENV_PREFIXES = ["PI_SMART_SEARCH_", "FAKE_SMART_SEARCH_"];

function ownedEnvKeys(): string[] {
	return Object.keys(process.env).filter((key) => ENV_PREFIXES.some((prefix) => key.startsWith(prefix)));
}

/** 注册测试钩子；返回的函数取当前用例的临时目录 */
export function useFakeCli(): () => string {
	let savedEnv: Record<string, string | undefined> = {};
	let savedTmpdir: string | undefined;
	let fileTmp = "";
	let workDir = "";
	// 私有输出根目录按进程缓存（src/output.ts），整个测试文件共用一个 TMPDIR，跑完一起删，不在真实 /tmp 留垃圾
	beforeAll(() => {
		savedTmpdir = process.env.TMPDIR;
		fileTmp = mkdtempSync(join(tmpdir(), "pi-smart-search-test-"));
		process.env.TMPDIR = fileTmp;
	});
	afterAll(() => {
		if (savedTmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = savedTmpdir;
		rmSync(fileTmp, { recursive: true, force: true });
	});
	beforeEach(() => {
		savedEnv = Object.fromEntries(ownedEnvKeys().map((key) => [key, process.env[key]]));
		for (const key of ownedEnvKeys()) delete process.env[key];
		process.env.PI_SMART_SEARCH_BIN = FAKE_CLI;
		workDir = mkdtempSync(join(fileTmp, "case-"));
	});
	afterEach(() => {
		for (const key of ownedEnvKeys()) delete process.env[key];
		Object.assign(process.env, savedEnv);
		rmSync(workDir, { recursive: true, force: true });
	});
	return () => workDir;
}

export function fake(mode: string, extra: Record<string, string> = {}): void {
	Object.assign(process.env, { FAKE_SMART_SEARCH_MODE: mode, ...extra });
}

export function fixture(name: string): string {
	return readFileSync(join(FIXTURES, name), "utf8");
}
