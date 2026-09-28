import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it, vi } from "vitest";
import extension from "../index.ts";
import { SmartSearchError } from "../src/runner.ts";
import { fake, fixture, useFakeCli } from "./helpers.ts";

const workDir = useFakeCli();

interface ToolResult {
	content: { type: string; text?: string }[];
	details: Record<string, unknown>;
}

interface RegisteredTool {
	name: string;
	promptGuidelines?: string[];
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: ((partial: ToolResult) => void) | undefined,
		ctx: unknown,
	): Promise<ToolResult>;
}

type Handler = (event: unknown, ctx: unknown) => unknown;

class FakePi {
	tools = new Map<string, RegisteredTool>();
	handlers = new Map<string, Handler[]>();
	activeTools = new Set<string>(["read", "bash"]);

	on(name: string, handler: Handler) {
		this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
	}

	registerTool(tool: RegisteredTool) {
		this.tools.set(tool.name, tool);
		this.activeTools.add(tool.name);
	}

	getActiveTools() {
		return [...this.activeTools];
	}

	excluded = new Set<string>();

	setActiveTools(names: string[]) {
		// pi 会静默忽略未注册的名字（--exclude-tools 排除的工具不会注册）
		this.activeTools = new Set(names.filter((name) => !this.excluded.has(name)));
	}

	emit(name: string, ctx: unknown = { hasUI: false }) {
		for (const handler of this.handlers.get(name) ?? []) handler({ type: name, reason: "startup" }, ctx);
	}

	async run(name: string, params: Record<string, unknown>, onUpdate?: (partial: ToolResult) => void, signal?: AbortSignal) {
		const tool = this.tools.get(name);
		if (!tool) throw new Error(`tool not registered: ${name}`);
		const result = await tool.execute("call-1", params, signal, onUpdate, {});
		return { ...result, text: result.content.map((block) => block.text ?? "").join("\n") };
	}
}

function install(): FakePi {
	const pi = new FakePi();
	extension(pi as unknown as ExtensionAPI);
	return pi;
}

function recordArgv(): () => string[] {
	const file = join(workDir(), "argv.json");
	process.env.FAKE_SMART_SEARCH_ARGV_FILE = file;
	return () => JSON.parse(readFileSync(file, "utf8")) as string[];
}

async function expectToolError(promise: Promise<unknown>, type: string): Promise<SmartSearchError> {
	const error = await promise.then(
		() => undefined,
		(reason: unknown) => reason,
	);
	expect(error).toBeInstanceOf(SmartSearchError);
	expect((error as SmartSearchError).type).toBe(type);
	return error as SmartSearchError;
}

function mode(path: string): number {
	return statSync(path).mode & 0o777;
}

const CORE_TOOLS = ["smart_search_tools", "smart_search_search", "smart_search_fetch", "smart_search_research"];
const DEFERRED_TOOLS = [
	"smart_search_exa_search",
	"smart_search_exa_similar",
	"smart_search_map",
	"smart_search_context7_library",
	"smart_search_context7_docs",
	"smart_search_plan",
	"smart_search_route",
	"smart_search_doctor",
	"smart_search_providers",
];
// pi-search 占用的工具名：两个扩展可能同时加载，同名会被 pi 记为加载错误
const PI_SEARCH_TOOLS = [
	"search_tools",
	"search",
	"docs_search",
	"web_fetch",
	"web_map",
	"search_sources",
	"search_planning",
	"search_config",
	"context7_resolve_library_id",
	"context7_query_docs",
	"context7_get_library_docs",
	"context7_get_cached_doc_raw",
];

describe("工具注册", () => {
	it("注册 13 个带前缀的工具，不与 pi-search 撞名", () => {
		const names = [...install().tools.keys()];
		expect(names.sort()).toEqual([...CORE_TOOLS, ...DEFERRED_TOOLS].sort());
		expect(names.filter((name) => PI_SEARCH_TOOLS.includes(name))).toEqual([]);
	});

	it("每条 promptGuidelines 都点名具体工具（pi 会把它们平铺进系统提示词）", () => {
		for (const tool of install().tools.values()) {
			for (const guideline of tool.promptGuidelines ?? []) expect(guideline).toMatch(/smart_search_\w+/);
		}
	});
});

describe("按需激活", () => {
	it("session_start 收起按需工具，只留核心工具", () => {
		const pi = install();
		pi.emit("session_start");
		expect(pi.getActiveTools().sort()).toEqual(["bash", "read", ...CORE_TOOLS].sort());
	});

	it("smart_search_tools 增量激活分组，重复激活不重复添加", async () => {
		const pi = install();
		pi.emit("session_start");
		const first = await pi.run("smart_search_tools", { groups: ["exa", "diagnostics", "exa"] });
		expect(first.text).toBe(
			[
				"Activated: smart_search_exa_search, smart_search_exa_similar, smart_search_doctor, smart_search_providers",
				"- exa: smart_search_exa_search, smart_search_exa_similar",
				"- diagnostics: smart_search_doctor, smart_search_providers",
			].join("\n"),
		);
		expect(pi.getActiveTools()).toEqual(expect.arrayContaining(["read", "smart_search_exa_search", "smart_search_doctor"]));
		expect(pi.getActiveTools()).not.toContain("smart_search_map");
		const second = await pi.run("smart_search_tools", { groups: ["exa"] });
		expect(second.text).toBe("No new tools were activated.\n- exa: smart_search_exa_search, smart_search_exa_similar");
	});

	it("被 --exclude-tools 排除的工具如实报告为不可用，而不是声称已激活", async () => {
		const pi = install();
		pi.excluded.add("smart_search_map");
		pi.emit("session_start");
		const result = await pi.run("smart_search_tools", { groups: ["site_map"] });
		expect(result.text).toBe("No new tools were activated.\nUnavailable in this session: smart_search_map\n- site_map: smart_search_map");
	});

	it("PI_SMART_SEARCH_DEFERRED_TOOLS=0 时不收起", () => {
		process.env.PI_SMART_SEARCH_DEFERRED_TOOLS = "0";
		const pi = install();
		pi.emit("session_start");
		expect(pi.getActiveTools()).toEqual(expect.arrayContaining(DEFERRED_TOOLS));
	});

	it("用户用 --tools 显式挑了工具时不改动（否则按需工具会被收掉，模型无工具可用）", () => {
		const pi = install();
		pi.setActiveTools(["smart_search_route"]);
		pi.emit("session_start");
		expect(pi.getActiveTools()).toEqual(["smart_search_route"]);
	});
});

describe("版本检查", () => {
	it("超出兼容范围时警告一次，之后的 session_start 不重复提示", async () => {
		fake("stdout", { FAKE_SMART_SEARCH_STDOUT: "smart-search 0.2.0\n" });
		const notify = vi.fn();
		const pi = install();
		pi.emit("session_start", { hasUI: true, ui: { notify } });
		await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1), { timeout: 5_000 });
		expect(notify.mock.calls[0]).toEqual([expect.stringContaining(">=0.1.25 <0.2.0"), "warning"]);
		pi.emit("session_start", { hasUI: true, ui: { notify } });
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("版本正常时不提示", async () => {
		const argv = recordArgv();
		fake("stdout", { FAKE_SMART_SEARCH_STDOUT: "smart-search 0.1.25\n" });
		const notify = vi.fn();
		install().emit("session_start", { hasUI: true, ui: { notify } });
		await vi.waitFor(() => expect(argv()).toEqual(["--version"]), { timeout: 5_000 });
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(notify).not.toHaveBeenCalled();
	});

	it("先进入无 UI 的会话时不算提示过，之后有 UI 的会话仍会提示", async () => {
		fake("stdout", { FAKE_SMART_SEARCH_STDOUT: "smart-search 0.2.0\n" });
		const notify = vi.fn();
		const pi = install();
		pi.emit("session_start", { hasUI: false });
		pi.emit("session_start", { hasUI: true, ui: { notify } });
		await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1), { timeout: 5_000 });
	});

	it("ctx 已过期（读 hasUI 就抛错）时不会产生未处理的 rejection", async () => {
		const argv = recordArgv();
		fake("stdout", { FAKE_SMART_SEARCH_STDOUT: "smart-search 0.2.0\n" });
		const stale = {
			get hasUI(): boolean {
				throw new Error("This extension ctx is stale after session replacement");
			},
		};
		const unhandled = vi.fn();
		process.on("unhandledRejection", unhandled);
		try {
			install().emit("session_start", stale);
			await vi.waitFor(() => expect(argv()).toEqual(["--version"]), { timeout: 5_000 });
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(unhandled).not.toHaveBeenCalled();
		} finally {
			process.off("unhandledRejection", unhandled);
		}
	});
});

describe("smart_search_search", () => {
	it("返回回答、编号信源和元信息，并推送计时进度", async () => {
		fake("stdout", { FAKE_SMART_SEARCH_STDOUT: fixture("search.ok.json") });
		const updates: string[] = [];
		const result = await install().run("smart_search_search", { query: "node:sqlite" }, (partial) => {
			updates.push(partial.content[0]?.text ?? "");
		});
		expect(result.text).toContain("Release Candidate");
		expect(result.text).toContain("Sources:\n[1] https://nodejs.cn/api/v24/sqlite/sqlite.html\n[2] https://togithub.com");
		expect(result.text).toContain("Smart Search: xai-responses (grok-4.20-multi-agent-xhigh), 28.8s");
		expect(updates[0]).toBe("Smart Search: running… 0s");
		expect(typeof result.details.elapsedMs).toBe("number");
	});

	it("参数映射到 CLI：选项用 = 写法，query 在 -- 之后", async () => {
		const argv = recordArgv();
		fake("stdout", { FAKE_SMART_SEARCH_STDOUT: fixture("search.ok.json") });
		await install().run("smart_search_search", { query: " --help ", platform: "GitHub", extra_sources: 2, validation: "strict" });
		expect(argv()).toEqual(["search", "--platform=GitHub", "--extra-sources=2", "--validation=strict", "--format=json", "--", "--help"]);
	});

	it("Sources 只列 primary_sources，补充来源单独列出", async () => {
		fake("stdout", {
			FAKE_SMART_SEARCH_STDOUT: JSON.stringify({
				ok: true,
				content: "answer [[1]]",
				primary_sources: [{ url: "https://primary.dev", title: "1" }],
				extra_sources: [{ url: "https://extra.dev", title: "Extra" }],
				sources: [{ url: "https://primary.dev", title: "1" }, { url: "https://extra.dev", title: "Extra" }],
			}),
		});
		const { text } = await install().run("smart_search_search", { query: "q" });
		expect(text).toContain("Sources:\n[1] https://primary.dev\n\nExtra sources (not used as evidence for the answer):\n- Extra — https://extra.dev");
	});

	// 上游的 URL 正则会在 "]" 处截断，https://[::1]/ 这类写法提取不出合法 URL，上游也抓取不了，这里不覆盖
	it.each(["summarize http://192.168.1.1/admin?token=abc", "看下 http://localhost:3000/。", "check http://169.254.169.254/latest/meta-data/"])(
		"query 里夹带内网 URL 时拒绝，不启动 CLI：%s",
		async (query) => {
			const argv = join(workDir(), "argv.json");
			process.env.FAKE_SMART_SEARCH_ARGV_FILE = argv;
			const error = await expectToolError(install().run("smart_search_search", { query }), "invalid_input");
			expect(error.message).toContain("private network URL");
			expect(error.message).not.toContain("token=abc");
			expect(existsSync(argv)).toBe(false);
		},
	);

	it("query 里的公网 URL 照常放行", async () => {
		fake("stdout", { FAKE_SMART_SEARCH_STDOUT: fixture("search.ok.json") });
		await install().run("smart_search_search", { query: "summarize https://example.com/a" });
	});

	it("可选字符串参数传空串时按没填处理", async () => {
		const argv = recordArgv();
		fake("stdout", { FAKE_SMART_SEARCH_STDOUT: fixture("search.ok.json") });
		await install().run("smart_search_search", { query: "q", platform: "  " });
		expect(argv()).toEqual(["search", "--format=json", "--", "q"]);
	});

	it("失败路径上也会清掉进度计时器", async () => {
		fake("stdout", { FAKE_SMART_SEARCH_STDOUT: '{"ok":false,"error_type":"network_error","error":"x"}', FAKE_SMART_SEARCH_EXIT: "4" });
		const onUpdate = vi.fn();
		await expectToolError(install().run("smart_search_search", { query: "q" }, onUpdate), "network_error");
		const calls = onUpdate.mock.calls.length;
		await new Promise((resolve) => setTimeout(resolve, 1_300));
		expect(onUpdate.mock.calls.length).toBe(calls);
	});

	it("空 query 在本地就被拒绝，不启动 CLI", async () => {
		const argv = join(workDir(), "argv.json");
		process.env.FAKE_SMART_SEARCH_ARGV_FILE = argv;
		await expectToolError(install().run("smart_search_search", { query: "   " }), "invalid_input");
		expect(existsSync(argv)).toBe(false);
	});

	it("CLI 报错时 throw，消息带 error_type、提示和 provider 尝试记录", async () => {
		fake("stdout", {
			FAKE_SMART_SEARCH_STDOUT: '{"ok":false,"error_type":"auth_error","error":"HTTP 401","provider_attempts":[{"provider":"xAI Responses","status":"error","error_type":"auth_error"}]}',
			FAKE_SMART_SEARCH_EXIT: "4",
		});
		const error = await expectToolError(install().run("smart_search_search", { query: "q" }), "auth_error");
		expect(error.message).toBe(
			"[auth_error] HTTP 401\nHint: Check the provider API key in the Smart Search config (`smart-search doctor`).\nAttempts: xAI Responses error(auth_error)",
		);
	});

	it("中止时报 cancelled", async () => {
		await expectToolError(install().run("smart_search_search", { query: "q" }, undefined, AbortSignal.abort()), "cancelled");
	});
});

describe("smart_search_fetch", () => {
	it("内网地址在本地就被拒绝，不启动 CLI", async () => {
		const argv = join(workDir(), "argv.json");
		process.env.FAKE_SMART_SEARCH_ARGV_FILE = argv;
		const error = await expectToolError(install().run("smart_search_fetch", { url: "http://127.0.0.1:8080/admin" }), "invalid_input");
		expect(error.message).toContain("private network");
		expect(existsSync(argv)).toBe(false);
	});

	it("超长正文截断到 12KB，完整内容存进私有文件（0600，目录 0700）", async () => {
		const content = "x".repeat(60_000); // 表头之后是一整行超长正文，按整行截断会只剩表头
		fake("stdout", { FAKE_SMART_SEARCH_STDOUT: JSON.stringify({ ok: true, url: "https://example.com/", provider: "tavily", content }) });
		const result = await install().run("smart_search_fetch", { url: "https://example.com/" });
		const fullPath = result.details.fullOutputPath as string;
		expect(result.text.startsWith("Fetched https://example.com/ via tavily (58.6KB)\n\nxxx")).toBe(true);
		expect(result.text).toContain(`[Output truncated: showing 12.0KB of 58.6KB. Full output saved to: ${fullPath}]`);
		expect(readFileSync(fullPath, "utf8")).toContain(content);
		expect(mode(fullPath)).toBe(0o600);
		expect(mode(dirname(fullPath))).toBe(0o700);
	});

	it("CLI 返回 parameter_error 时 throw", async () => {
		fake("stdout", { FAKE_SMART_SEARCH_STDOUT: fixture("fetch.parameter_error.json"), FAKE_SMART_SEARCH_EXIT: "2" });
		await expectToolError(install().run("smart_search_fetch", { url: "https://example.com/" }), "parameter_error");
	});
});

describe("smart_search_research", () => {
	it("证据写成私有文件，返回索引而不是 final_answer；--evidence-dir 指向私有目录", async () => {
		const argv = recordArgv();
		fake("stdout", { FAKE_SMART_SEARCH_STDOUT: fixture("research.ok.json") });
		const result = await install().run("smart_search_research", { query: "pi onUpdate" });

		const args = argv();
		expect(args.slice(0, 2)).toEqual(["research", "--budget=standard"]);
		const evidenceArg = args.find((arg) => arg.startsWith("--evidence-dir="))!;
		const researchDir = dirname(evidenceArg.slice("--evidence-dir=".length));
		expect(evidenceArg).toBe(`--evidence-dir=${join(researchDir, "cli")}`);
		expect(mode(researchDir)).toBe(0o700);
		expect(mode(dirname(researchDir))).toBe(0o700);

		expect(result.text).toContain("Research: pi coding agent 扩展 registerTool onUpdate 进度回调怎么用");
		expect(result.text).toContain("budget=quick, 21.1s, gap_check=closed (evidence_converged)");
		expect(result.text).toContain("[1] pi/packages/coding-agent/CHANGELOG.md at main");
		expect(result.text).toContain("Search snippet (unverified): Tools registered via pi.registerTool() The onUpdate callback");
		expect(result.text).not.toContain("Summary:");
		expect(result.text).toContain("This is an evidence index, not an answer.");
		expect(result.text).not.toContain("Evidence-backed findings");

		const first = join(researchDir, "evidence-01.md");
		expect(result.text).toContain(first);
		expect(readFileSync(first, "utf8").startsWith("Source: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md\n")).toBe(true);
		expect(mode(first)).toBe(0o600);
		expect(existsSync(join(researchDir, "evidence-05.md"))).toBe(true);
	});
});

describe("smart_search_research 的输入检查", () => {
	it("query 里夹带内网 URL 时拒绝，不启动 CLI", async () => {
		const argv = join(workDir(), "argv.json");
		process.env.FAKE_SMART_SEARCH_ARGV_FILE = argv;
		await expectToolError(install().run("smart_search_research", { query: "对比 http://10.0.0.5/wiki 和官方文档" }), "invalid_input");
		expect(existsSync(argv)).toBe(false);
	});
});

describe("renderResult", () => {
	const theme = { fg: (_color: string, text: string) => text } as never;
	// keyHint 读取 pi 的全局主题；真实 pi 里已初始化，测试里要手动初始化
	beforeAll(() => initTheme());

	function render(output: string, options: { expanded: boolean; isPartial: boolean }): string {
		const tool = install().tools.get("smart_search_search") as unknown as {
			renderResult(result: unknown, options: unknown, theme: unknown, context: unknown): { render(width: number): string[] };
		};
		return tool.renderResult({ content: [{ type: "text", text: output }], details: {} }, options, theme, {}).render(200).join("\n");
	}

	it("完成后默认只显示前 12 行，并提示剩余行数", () => {
		const output = Array.from({ length: 20 }, (_, index) => `L${index + 1}`).join("\n");
		const folded = render(output, { expanded: false, isPartial: false });
		expect(folded).toContain("L12");
		expect(folded).not.toContain("L13");
		expect(folded).toContain("8 more lines");
		expect(render(output, { expanded: true, isPartial: false })).toContain("L20");
	});

	it("运行中显示进度文本", () => {
		expect(render("Smart Search: running… 3s", { expanded: false, isPartial: true })).toContain("running… 3s");
	});
});

describe("按需工具", () => {
	it("smart_search_exa_search 的参数完整映射", async () => {
		const argv = recordArgv();
		fake("stdout", { FAKE_SMART_SEARCH_STDOUT: fixture("exa_search.ok.json") });
		const result = await install().run("smart_search_exa_search", {
			query: "q",
			num_results: 3,
			search_type: "keyword",
			include_domains: ["github.com", "pi.dev"],
			start_published_date: "2026-01-01",
			category: "github",
			include_highlights: true,
		});
		expect(argv()).toEqual([
			"exa-search",
			"--num-results=3",
			"--search-type=keyword",
			"--include-domains",
			"github.com",
			"pi.dev",
			"--start-published-date=2026-01-01",
			"--category=github",
			"--include-highlights",
			"--format=json",
			"--",
			"q",
		]);
		expect(result.text).toContain("[1] packages/coding-agent/docs/extensions.md");
	});

	it("列表参数的值以 - 开头时拒绝（会被 argparse 当成新选项）", async () => {
		await expectToolError(
			install().run("smart_search_exa_search", { query: "q", include_domains: ["github.com", "--output=/tmp/x"] }),
			"invalid_input",
		);
	});

	it("smart_search_context7_library 只在有 query 时才传第二个位置参数", async () => {
		const argv = recordArgv();
		fake("stdout", { FAKE_SMART_SEARCH_STDOUT: '{"ok":true,"content":"candidates"}' });
		const pi = install();
		await pi.run("smart_search_context7_library", { name: "react" });
		expect(argv()).toEqual(["context7-library", "--format=json", "--", "react"]);
		await pi.run("smart_search_context7_library", { name: "react", query: "hooks" });
		expect(argv()).toEqual(["context7-library", "--format=json", "--", "react", "hooks"]);
	});

	it("smart_search_context7_library 未配置时报 config_error", async () => {
		fake("stdout", { FAKE_SMART_SEARCH_STDOUT: fixture("context7_library.config_error.json"), FAKE_SMART_SEARCH_EXIT: "3" });
		const error = await expectToolError(install().run("smart_search_context7_library", { name: "react" }), "config_error");
		expect(error.message).toContain("CONTEXT7_API_KEY is not configured");
	});

	it("smart_search_doctor 在 ok:false 时仍返回诊断内容，而不是报错", async () => {
		fake("stdout", { FAKE_SMART_SEARCH_STDOUT: fixture("doctor.config_error.json"), FAKE_SMART_SEARCH_EXIT: "3" });
		const result = await install().run("smart_search_doctor", {});
		expect(result.text).toContain('"minimum_profile_missing"');
		expect(result.text).not.toContain("config_sources");
	});

	it("smart_search_providers 调用 providers status", async () => {
		const argv = recordArgv();
		fake("stdout", { FAKE_SMART_SEARCH_STDOUT: fixture("providers.ok.json") });
		const result = await install().run("smart_search_providers", {});
		expect(argv()).toEqual(["providers", "status", "--format=json"]);
		expect(result.text).toContain("- exa: closed, failures=0");
	});

	it("smart_search_plan 去掉会写公共 /tmp 的 CLI 命令行", async () => {
		fake("stdout", { FAKE_SMART_SEARCH_STDOUT: fixture("plan.ok.json") });
		const result = await install().run("smart_search_plan", { query: "q" });
		expect(result.text).not.toContain("/tmp/smart-search-evidence");
		expect(result.text).not.toMatch(/"(command|output_path|evidence_dir)"/);
		expect(result.text).toContain('"steps"');
	});

	it("smart_search_map 校验 URL 并映射选项", async () => {
		const argv = recordArgv();
		fake("stdout", { FAKE_SMART_SEARCH_STDOUT: fixture("map.ok.json") });
		const result = await install().run("smart_search_map", { url: "https://pi.dev/docs/latest", max_depth: 2, limit: 10 });
		expect(argv()).toEqual(["map", "--max-depth=2", "--limit=10", "--format=json", "--", "https://pi.dev/docs/latest"]);
		expect(result.text).toContain("Site map for https://pi.dev/docs/latest (10 URL(s)):");
		await expectToolError(install().run("smart_search_map", { url: "http://192.168.1.1/" }), "invalid_input");
	});
});
