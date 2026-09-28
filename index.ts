// pi 扩展入口：把 smart-search CLI 的命令注册成 pi 工具
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	keyHint,
	type AgentToolResult,
	type ExtensionAPI,
	type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { Type, type Static, type TSchema } from "typebox";
import {
	formatDoctor,
	formatExa,
	formatFetch,
	formatContext7Docs,
	formatContext7Library,
	formatGeneric,
	formatPlan,
	formatMap,
	formatProviders,
	formatResearch,
	formatSearch,
} from "./src/format.ts";
import { makePrivateDir, truncateForModel } from "./src/output.ts";
import {
	checkCliVersion,
	runSmartSearch,
	SmartSearchError,
	type CliCall,
	type CliStatus,
	type RunResult,
} from "./src/runner.ts";
import { assertNoPrivateUrls, normalizePublicUrl, normalizeText } from "./src/validate.ts";

const TOOL_GROUPS = {
	exa: ["smart_search_exa_search", "smart_search_exa_similar"],
	site_map: ["smart_search_map"],
	context7: ["smart_search_context7_library", "smart_search_context7_docs"],
	planning: ["smart_search_plan", "smart_search_route"],
	diagnostics: ["smart_search_doctor", "smart_search_providers"],
} as const;
type ToolGroup = keyof typeof TOOL_GROUPS;
const TOOL_GROUP_NAMES = Object.keys(TOOL_GROUPS) as ToolGroup[];
const DEFERRED_TOOLS = new Set<string>(Object.values(TOOL_GROUPS).flat());

const VALIDATION = StringEnum(["fast", "balanced", "strict"] as const, {
	description: "Evidence validation level (default: the Smart Search config).",
});
const BUDGET = StringEnum(["quick", "standard", "deep"] as const, {
	description: "quick (~20s), standard (default), or deep (slowest, most thorough).",
	default: "standard",
});

interface SmartSearchDetails {
	elapsedMs?: number;
	fullOutputPath?: string;
}

type Run = (call: CliCall) => Promise<RunResult>;

interface CliToolSpec<T extends TSchema> {
	name: string;
	label: string;
	description: string;
	promptSnippet: string;
	promptGuidelines?: string[];
	parameters: T;
	/** 返回给模型的文本（截断前） */
	execute(params: Static<T>, run: Run): Promise<string>;
}

// 模型常给可选字段填空字符串，按"没填"处理
function optionalText(value: string | undefined, label: string): string | undefined {
	return value === undefined || !value.trim() ? undefined : normalizeText(value, label);
}

function textOf(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text || "")
		.join("\n")
		.replace(/\r/g, "");
}

// 改写自 pi-search 的 renderPiSearchResult（MIT License, Copyright (c) 2025，见 LICENSE）：
// 运行中显示计时进度文本，完成后默认折叠成前 12 行
const PREVIEW_LINES = 12;
const PREVIEW_CHARS = 4000;

function renderResult(result: AgentToolResult<unknown>, { expanded, isPartial }: ToolRenderResultOptions, theme: Theme): Component {
	const output = textOf(result);
	if (isPartial) return new Text(theme.fg("warning", output || "Running..."), 0, 0);
	if (!output) return new Text("", 0, 0);

	const lines = output.split("\n");
	const visibleLines = expanded ? lines : lines.slice(0, PREVIEW_LINES);
	let display = visibleLines.join("\n");
	let hiddenLines = expanded ? 0 : lines.length - visibleLines.length;
	if (!expanded && display.length > PREVIEW_CHARS) {
		display = display.slice(0, PREVIEW_CHARS).trimEnd();
		hiddenLines = Math.max(hiddenLines, 1);
	}
	if (hiddenLines > 0) {
		display += `\n${theme.fg("muted", `... (${hiddenLines} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
	}
	return new Text(theme.fg("toolOutput", display), 0, 0);
}

export default function smartSearchExtension(pi: ExtensionAPI) {
	const deferredLoading = process.env.PI_SMART_SEARCH_DEFERRED_TOOLS !== "0";
	const registeredTools: string[] = [];
	let versionCheck: Promise<CliStatus> | undefined;
	let versionNotified = false;

	function registerCliTool<T extends TSchema>(spec: CliToolSpec<T>): void {
		registeredTools.push(spec.name);
		pi.registerTool<T, SmartSearchDetails>({
			name: spec.name,
			label: spec.label,
			description: spec.description,
			promptSnippet: spec.promptSnippet,
			promptGuidelines: spec.promptGuidelines,
			parameters: spec.parameters,
			renderResult,
			async execute(_toolCallId, params, signal, onUpdate) {
				const started = Date.now();
				const tick = () =>
					onUpdate?.({
						content: [{ type: "text", text: `${spec.label}: running… ${Math.floor((Date.now() - started) / 1000)}s` }],
						details: {},
					});
				tick();
				const timer = setInterval(tick, 1000);
				let elapsedMs: number | undefined;
				try {
					const run: Run = async (call) => {
						const result = await runSmartSearch(call, { signal });
						elapsedMs = result.elapsedMs;
						return result;
					};
					const output = await truncateForModel(await spec.execute(params, run), spec.name);
					return {
						content: [{ type: "text", text: output.text }],
						details: { elapsedMs, fullOutputPath: output.fullOutputPath },
					};
				} finally {
					clearInterval(timer);
				}
			},
		});
	}

	pi.on("session_start", (_event, ctx) => {
		// 只在默认状态（本扩展的工具全部激活）时收起按需工具；用户用 --tools 挑过工具时尊重其选择
		const active = pi.getActiveTools();
		if (deferredLoading && registeredTools.every((name) => active.includes(name))) {
			pi.setActiveTools(active.filter((name) => !DEFERRED_TOOLS.has(name)));
		}
		// 检查结果按扩展运行时缓存（pi 在 new/resume/fork/reload 时会重建运行时），但要等到有 UI 的会话才算提示过；
		// 不能在工厂函数里起进程（extensions.md「Respect the runtime lifecycle」）
		versionCheck ??= checkCliVersion();
		void versionCheck.then((status) => {
			if (status.state === "ok" || versionNotified) return;
			try {
				// ctx 过期后连读 hasUI 都会抛错，必须放在 try 里，否则会变成未处理的 rejection 让 pi 退出
				if (!ctx.hasUI) return;
				ctx.ui.notify(`pi-smart-search: ${status.message}`, "warning");
				versionNotified = true;
			} catch {
				// 会话已被替换，旧 ctx 失效
			}
		});
	});

	registeredTools.push("smart_search_tools");
	pi.registerTool({
		name: "smart_search_tools",
		label: "Smart Search Tools",
		description:
			"Activate optional Smart Search tool groups for this session: exa (Exa source search with domain/date filters, similar pages), site_map (list a website's URLs), context7 (library documentation), planning (offline research plan, routing explanation), diagnostics (CLI configuration and provider health). smart_search_search, smart_search_fetch, and smart_search_research are always available.",
		promptSnippet: "Activate optional Smart Search tool groups (exa, site_map, context7, planning, diagnostics).",
		promptGuidelines: [
			"Use smart_search_tools only when a task needs an optional Smart Search group; request only the needed groups, and activation lasts for the session.",
		],
		parameters: Type.Object({
			groups: Type.Array(StringEnum(TOOL_GROUP_NAMES), { minItems: 1, maxItems: TOOL_GROUP_NAMES.length }),
		}),
		renderResult,
		async execute(_toolCallId, params) {
			const groups = [...new Set(params.groups)];
			const requested = groups.flatMap((group) => TOOL_GROUPS[group]);
			const before = pi.getActiveTools();
			pi.setActiveTools([...new Set([...before, ...requested])]);
			// pi 会静默忽略未注册的名字（例如被 --exclude-tools 排除），所以以设置后的真实状态为准
			const after = pi.getActiveTools();
			const added = requested.filter((name) => after.includes(name) && !before.includes(name));
			const unavailable = requested.filter((name) => !after.includes(name));
			const lines = [
				added.length > 0 ? `Activated: ${added.join(", ")}` : "No new tools were activated.",
				...(unavailable.length > 0 ? [`Unavailable in this session: ${unavailable.join(", ")}`] : []),
				...groups.map((group) => `- ${group}: ${TOOL_GROUPS[group].join(", ")}`),
			];
			return { content: [{ type: "text", text: lines.join("\n") }], details: { groups, added, unavailable } };
		},
	});

	registerCliTool({
		name: "smart_search_search",
		label: "Smart Search",
		description:
			"Search the web through the Smart Search CLI (multi-provider routing with fallback) and return an answer with numbered source URLs. Documentation and API questions also get supplemental documentation sources. Local and private network URLs in the query are rejected.",
		promptSnippet: "Web search with an evidence-backed answer and numbered sources.",
		promptGuidelines: [
			"Use smart_search_search for questions that need current or external web information, and cite the numbered source URLs it returns.",
			"Use smart_search_fetch instead of smart_search_search when you already know the URL to read.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Focused search query." }),
			platform: Type.Optional(Type.String({ description: "Optional platform to focus on, e.g. GitHub, Reddit, or X." })),
			extra_sources: Type.Optional(
				Type.Integer({ minimum: 0, maximum: 5, description: "Extra Tavily/Firecrawl source candidates to list (default 0)." }),
			),
			validation: Type.Optional(VALIDATION),
		}),
		async execute(params, run) {
			const { data } = await run({
				command: ["search"],
				options: {
					platform: optionalText(params.platform, "platform"),
					"extra-sources": params.extra_sources,
					validation: params.validation,
				},
				positionals: [assertNoPrivateUrls(normalizeText(params.query, "query"), "query")],
			});
			return formatSearch(data);
		},
	});

	registerCliTool({
		name: "smart_search_fetch",
		label: "Smart Search Fetch",
		description:
			"Fetch one public http(s) URL as Markdown through Smart Search's fetch fallback chain. Local and private network URLs are rejected. Output over 12KB is truncated and the full text is saved to a private file whose path is returned.",
		promptSnippet: "Read a public web page as Markdown.",
		promptGuidelines: [
			"Use smart_search_fetch to read a known public URL; when its output says it was truncated, read the saved file path for the rest.",
		],
		parameters: Type.Object({ url: Type.String({ description: "Absolute public http(s) URL." }) }),
		async execute(params, run) {
			const { data } = await run({ command: ["fetch"], positionals: [normalizePublicUrl(params.url)] });
			return formatFetch(data);
		},
	});

	registerCliTool({
		name: "smart_search_research",
		label: "Smart Search Research",
		description:
			"Run Smart Search's evidence-gathering pipeline (plan, search, fetch candidate pages, gap check). Returns an evidence index with titles, URLs, and unverified search snippets, and saves each page's full text to a private file. It does not write an answer. Local and private network URLs in the query are rejected.",
		promptSnippet: "Gather page-level web evidence for a multi-source question.",
		promptGuidelines: [
			"Use smart_search_research for questions that need evidence from several pages; it returns only an evidence index, so read the relevant evidence files and write the answer yourself with source URLs.",
			"Prefer smart_search_search for simple lookups because smart_search_research is slower.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Research question." }),
			budget: Type.Optional(BUDGET),
		}),
		async execute(params, run) {
			const query = assertNoPrivateUrls(normalizeText(params.query, "query"), "query");
			const dir = await makePrivateDir("research");
			const { data } = await run({
				command: ["research"],
				// CLI 默认把证据写到 /tmp/smart-search-evidence（0644），改到私有目录
				options: { budget: params.budget ?? "standard", "evidence-dir": join(dir, "cli") },
				positionals: [query],
			});
			return formatResearch(data, dir);
		},
	});

	registerCliTool({
		name: "smart_search_exa_search",
		label: "Exa Search",
		description:
			"Search with Exa and return source URLs (no synthesized answer). Supports domain filters, a published-date lower bound, a category, and highlight snippets.",
		promptSnippet: "Exa source search with domain, date, and category filters.",
		promptGuidelines: [
			"Use smart_search_exa_search when you need source URLs limited to specific domains, a date range, or a category such as research paper or github.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query." }),
			num_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 25, description: "Number of results (default 5)." })),
			search_type: Type.Optional(StringEnum(["neural", "keyword", "auto"] as const, { description: "Default: neural." })),
			include_domains: Type.Optional(Type.Array(Type.String(), { maxItems: 20, description: "Only return these domains." })),
			exclude_domains: Type.Optional(Type.Array(Type.String(), { maxItems: 20, description: "Exclude these domains." })),
			start_published_date: Type.Optional(Type.String({ description: "Earliest published date, ISO 8601 (e.g. 2026-01-01)." })),
			category: Type.Optional(Type.String({ description: "Exa category, e.g. research paper, news, github, pdf." })),
			include_highlights: Type.Optional(Type.Boolean({ description: "Include highlight snippets for each result." })),
		}),
		async execute(params, run) {
			const domains = (values: string[] | undefined, label: string) =>
				values?.map((value, index) => normalizeText(value, `${label}[${index}]`));
			const { data } = await run({
				command: ["exa-search"],
				options: {
					"num-results": params.num_results,
					"search-type": params.search_type,
					"include-domains": domains(params.include_domains, "include_domains"),
					"exclude-domains": domains(params.exclude_domains, "exclude_domains"),
					"start-published-date": optionalText(params.start_published_date, "start_published_date"),
					category: optionalText(params.category, "category"),
					"include-highlights": params.include_highlights,
				},
				positionals: [normalizeText(params.query, "query")],
			});
			return formatExa(data);
		},
	});

	registerCliTool({
		name: "smart_search_exa_similar",
		label: "Exa Similar",
		description: "Find pages similar to a public URL with Exa and return their URLs.",
		promptSnippet: "Find pages similar to a URL with Exa.",
		parameters: Type.Object({
			url: Type.String({ description: "Absolute public http(s) URL." }),
			num_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 25, description: "Number of results (default 5)." })),
		}),
		async execute(params, run) {
			const { data } = await run({
				command: ["exa-similar"],
				options: { "num-results": params.num_results },
				positionals: [normalizePublicUrl(params.url)],
			});
			return formatExa(data);
		},
	});

	registerCliTool({
		name: "smart_search_map",
		label: "Smart Search Map",
		description: "List URLs of a public website (Tavily Map) to discover pages before fetching them.",
		promptSnippet: "List a website's URLs.",
		promptGuidelines: ["Use smart_search_map to discover pages on a site, then smart_search_fetch the relevant ones."],
		parameters: Type.Object({
			url: Type.String({ description: "Absolute public http(s) URL of the site or section." }),
			instructions: Type.Optional(Type.String({ description: "Natural-language hint about which pages matter." })),
			max_depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, description: "Link depth (default 1)." })),
			max_breadth: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Links per page (default 20)." })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Maximum URLs (default 50)." })),
		}),
		async execute(params, run) {
			const { data } = await run({
				command: ["map"],
				options: {
					instructions: optionalText(params.instructions, "instructions"),
					"max-depth": params.max_depth,
					"max-breadth": params.max_breadth,
					limit: params.limit,
				},
				positionals: [normalizePublicUrl(params.url)],
			});
			return formatMap(data);
		},
	});

	registerCliTool({
		name: "smart_search_context7_library",
		label: "Context7 Library",
		description: "Resolve a library or framework name to Context7 library IDs.",
		promptSnippet: "Resolve a library name to Context7 library IDs.",
		promptGuidelines: [
			"Use smart_search_context7_library to get a library_id, then call smart_search_context7_docs with that id.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Library or framework name, e.g. react." }),
			query: Type.Optional(Type.String({ description: "Optional topic to rank candidates." })),
		}),
		async execute(params, run) {
			const query = optionalText(params.query, "query");
			const { data } = await run({
				command: ["context7-library"],
				positionals: [normalizeText(params.name, "name"), ...(query ? [query] : [])],
			});
			return formatContext7Library(data);
		},
	});

	registerCliTool({
		name: "smart_search_context7_docs",
		label: "Context7 Docs",
		description: "Fetch Context7 documentation for a library_id (from smart_search_context7_library), focused on a query.",
		promptSnippet: "Read library documentation from Context7.",
		parameters: Type.Object({
			library_id: Type.String({ description: "Context7 library ID, e.g. /facebook/react." }),
			query: Type.String({ description: "Topic to focus the documentation on." }),
		}),
		async execute(params, run) {
			const { data } = await run({
				command: ["context7-docs"],
				positionals: [normalizeText(params.library_id, "library_id"), normalizeText(params.query, "query")],
			});
			return formatContext7Docs(data);
		},
	});

	registerCliTool({
		name: "smart_search_plan",
		label: "Smart Search Plan",
		description:
			"Build an offline deep-research plan (no provider calls): sub-questions, capability plan, and evidence policy.",
		promptSnippet: "Offline research plan without provider calls.",
		parameters: Type.Object({
			query: Type.String({ description: "Research question." }),
			budget: Type.Optional(BUDGET),
		}),
		async execute(params, run) {
			const { data } = await run({
				command: ["deep"],
				options: { budget: params.budget },
				positionals: [normalizeText(params.query, "query")],
			});
			return formatPlan(data);
		},
	});

	registerCliTool({
		name: "smart_search_route",
		label: "Smart Search Route",
		description: "Explain how Smart Search would route a query (intents and required capabilities) without running providers.",
		promptSnippet: "Explain Smart Search routing for a query.",
		parameters: Type.Object({
			query: Type.String({ description: "Query to route." }),
			validation: Type.Optional(VALIDATION),
		}),
		async execute(params, run) {
			const { data } = await run({
				command: ["route"],
				options: { validation: params.validation },
				positionals: [normalizeText(params.query, "query")],
			});
			return formatGeneric(data);
		},
	});

	registerCliTool({
		name: "smart_search_doctor",
		label: "Smart Search Doctor",
		description: "Check Smart Search configuration and provider connectivity. Makes live probe requests (about 10s).",
		promptSnippet: "Diagnose Smart Search configuration and connectivity.",
		parameters: Type.Object({}),
		async execute(_params, run) {
			// 配置不完整时 doctor 返回 ok:false，但诊断内容正是模型要看的，不当成工具失败
			try {
				return formatDoctor((await run({ command: ["doctor"] })).data);
			} catch (error) {
				if (error instanceof SmartSearchError && error.data) return formatDoctor(error.data);
				throw error;
			}
		},
	});

	registerCliTool({
		name: "smart_search_providers",
		label: "Smart Search Providers",
		description: "Show Smart Search provider health: consecutive failures and cooldowns.",
		promptSnippet: "Show Smart Search provider health and cooldowns.",
		parameters: Type.Object({}),
		async execute(_params, run) {
			return formatProviders((await run({ command: ["providers", "status"] })).data);
		},
	});
}
