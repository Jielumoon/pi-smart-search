// 把 smart-search 的 JSON 结果转成给模型看的文本；字段缺失时尽量降级而不是报错（上游字段还在变）
import { formatSize } from "@earendil-works/pi-coding-agent";
import { writePrivateFile } from "./output.ts";

export type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function records(value: unknown): Json[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

// 标题、URL 这类单行字段来自第三方网页：去掉换行和控制字符，防止伪造出一行独立的 "[2] ..." 来源
function inline(value: unknown, maxChars = 300): string {
	const flat = str(value)
		.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}

function seconds(ms: unknown): string {
	return typeof ms === "number" && Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}s` : "?";
}

function bytes(text: string): string {
	return formatSize(Buffer.byteLength(text, "utf8"));
}

function json(data: unknown): string {
	return JSON.stringify(data, null, 2);
}

function join(parts: string[]): string {
	return parts.filter(Boolean).join("\n\n");
}

// ok:true 但有降级信息时给出 Warnings 段，不当成错误；超长输出会截掉结尾，所以大块正文之前就要放出来
export function formatWarnings(data: Json): string {
	const lines = records(data.provider_notices).map((notice) => {
		const errorType = inline(notice.error_type);
		const error = inline(notice.error, 200);
		const hint = inline(notice.hint);
		return `- ${inline(notice.provider)} ${inline(notice.capability)} ${inline(notice.status)}${errorType ? `(${errorType})` : ""}${
			error ? `: ${error}` : ""
		}${hint ? ` Hint: ${hint}` : ""}`;
	});
	for (const key of ["source_warning", "timeout_warning"]) {
		if (str(data[key])) lines.push(`- ${inline(data[key])}`);
	}
	if (data.partial_success === true) lines.push("- Partial result: some phases timed out or failed.");
	if (data.degraded === true) lines.push("- Smart Search ran in degraded mode.");
	return lines.length > 0 ? `Warnings:\n${lines.join("\n")}` : "";
}

export function formatSearch(data: Json): string {
	// sources 是 primary + extra 合并去重后的兼容字段；回答的依据只有 primary_sources
	const primary = Array.isArray(data.primary_sources) ? data.primary_sources : data.sources;
	// title 是正文里 [[n]] 的引用编号，不是网页标题
	const sources = records(primary).map((source, index) => {
		const title = inline(source.title);
		const label = /^\d+$/.test(title) ? `[${title}]` : `[${index + 1}]${title ? ` ${title} —` : ""}`;
		return `${label} ${inline(source.url, 2000)}`;
	});
	const extras = records(data.extra_sources).map(
		(source) => `- ${inline(source.title) || inline(source.url, 2000)} — ${inline(source.url, 2000)}`,
	);
	const model = inline(data.model);
	return join([
		str(data.content) || "(empty answer)",
		sources.length > 0 ? `Sources:\n${sources.join("\n")}` : "",
		extras.length > 0 ? `Extra sources (not used as evidence for the answer):\n${extras.join("\n")}` : "",
		`Smart Search: ${inline(data.provider) || "?"}${model ? ` (${model})` : ""}, ${seconds(data.elapsed_ms)}`,
		formatWarnings(data),
	]);
}

export function formatFetch(data: Json): string {
	const content = str(data.content);
	return join([
		`Fetched ${inline(data.url, 2000)} via ${inline(data.provider) || "?"} (${bytes(content)})`,
		formatWarnings(data),
		content,
	]);
}

// 每条证据写成独立文件：CLI 自己的 fetch-NN 用的是候选序号，跟 evidence_items 对不上
export async function formatResearch(data: Json, dir: string): Promise<string> {
	const snippets = new Map(records(data.discovery_sources).map((source) => [str(source.url), source.description]));
	const items = records(data.evidence_items);
	const gapCheck = isRecord(data.gap_check) ? data.gap_check : {};
	const stopReason = inline(gapCheck.stop_reason);
	const lines = [
		`Research: ${inline(data.question, 1000)}`,
		`budget=${inline(data.budget) || "?"}, ${seconds(data.elapsed_ms)}, gap_check=${inline(gapCheck.status) || "?"}${stopReason ? ` (${stopReason})` : ""}`,
		`${items.length} evidence item(s); full page text is saved in ${dir}`,
	];
	for (const [index, item] of items.entries()) {
		const url = inline(item.url, 2000);
		const title = inline(item.title) || url;
		const provider = inline(item.provider);
		const content = typeof item.content === "string" ? item.content : "";
		let location: string;
		try {
			location = await writePrivateFile(
				dir,
				`evidence-${String(index + 1).padStart(2, "0")}.md`,
				`Source: ${url}\nTitle: ${title}\nProvider: ${provider}\n\n---\n\n${content}`,
			);
		} catch (error) {
			// CLI 已经成功、付费调用已经发生，单个文件写不进去不能让整个结果作废
			location = `(not saved: ${error instanceof Error ? error.message : String(error)})`;
		}
		lines.push("", `[${index + 1}] ${title}`, `    ${url}`, `    ${provider || "?"} · ${bytes(content)} · ${location}`);
		// discovery 摘录来自搜索结果，没有和证据正文核对过
		const snippet = inline(snippets.get(str(item.url)));
		if (snippet) lines.push(`    Search snippet (unverified): ${snippet}`);
	}
	const gaps = records(gapCheck.gaps).map((gap) => `- ${inline(gap.reason) || inline(json(gap))}`);
	if (gaps.length > 0) lines.push("", "Unverified gaps:", ...gaps);
	lines.push(
		"",
		"This is an evidence index, not an answer. Search snippets are unverified; read the relevant evidence files, draw conclusions yourself, and cite the source URLs.",
	);
	return join([lines.join("\n"), formatWarnings(data)]);
}

export function formatExa(data: Json): string {
	const results = records(data.results);
	const target = str(data.query) ? ` for: ${inline(data.query, 1000)}` : str(data.url) ? ` similar to: ${inline(data.url, 2000)}` : "";
	const lines = [`Exa returned ${results.length} result(s)${target}`];
	for (const [index, result] of results.entries()) {
		const meta = [inline(result.publishedDate) && `published ${inline(result.publishedDate)}`, inline(result.author) && `by ${inline(result.author)}`]
			.filter(Boolean)
			.join(", ");
		lines.push("", `[${index + 1}] ${inline(result.title) || inline(result.url, 2000)}`, `    ${inline(result.url, 2000)}${meta ? ` (${meta})` : ""}`);
		for (const highlight of Array.isArray(result.highlights) ? result.highlights : []) {
			if (inline(highlight)) lines.push(`    > ${inline(highlight, 600)}`);
		}
		if (inline(result.text)) lines.push(`    ${inline(result.text, 600)}`);
	}
	return join([lines.join("\n"), formatWarnings(data)]);
}

export function formatMap(data: Json): string {
	const urls = (Array.isArray(data.results) ? data.results : [])
		.map((entry) => inline(isRecord(entry) ? entry.url : entry, 2000))
		.filter(Boolean);
	return join([`Site map for ${inline(data.base_url, 2000) || inline(data.url, 2000)} (${urls.length} URL(s)):\n${urls.join("\n")}`, formatWarnings(data)]);
}

export function formatProviders(data: Json): string {
	const lines = [`Provider health (cooldown ${data.cooldown_seconds ?? "?"}s after ${data.failure_threshold ?? "?"} failures):`];
	for (const provider of records(data.providers)) {
		const cooldown = typeof provider.cooldown_remaining_seconds === "number" ? provider.cooldown_remaining_seconds : 0;
		const error = inline(provider.error, 200);
		lines.push(
			`- ${inline(provider.provider)}: ${inline(provider.state) || "?"}, failures=${provider.consecutive_failures ?? 0}${
				cooldown > 0 ? `, cooldown ${Math.ceil(cooldown)}s` : ""
			}${error ? `, last error (${inline(provider.error_type)}): ${error}` : ""}`,
		);
	}
	// 列表只包含已配置的可选 provider，以及记录过失败的 provider（service.py provider_health_status）
	if (lines.length === 1) lines.push("- No optional providers are configured.");
	return lines.join("\n");
}

// doctor 的完整输出里有上百个配置项，只挑诊断有用的部分
const DOCTOR_FIELDS = [
	"ok",
	"error_type",
	"error",
	"config_status",
	"config_file",
	"config_parameter_errors",
	"minimum_profile_ok",
	"minimum_profile_missing",
	"capability_status",
	"provider_health",
];

export function formatDoctor(data: Json): string {
	const picked: Json = {};
	for (const [key, value] of Object.entries(data)) {
		if (key.endsWith("_connection_test") || key.endsWith("_connection_tests") || DOCTOR_FIELDS.includes(key)) picked[key] = value;
	}
	return json(picked);
}

export function formatContext7Library(data: Json): string {
	const results = records(data.results);
	const lines = [`Context7 returned ${results.length} librar${results.length === 1 ? "y" : "ies"}${str(data.query) ? ` for: ${inline(data.query)}` : ""}`];
	for (const [index, library] of results.entries()) {
		const stats = [
			typeof library.total_snippets === "number" && `${library.total_snippets} snippets`,
			typeof library.trust_score === "number" && `trust ${library.trust_score}`,
			typeof library.stars === "number" && `${library.stars} stars`,
		]
			.filter(Boolean)
			.join(", ");
		lines.push("", `[${index + 1}] ${inline(library.id)} — ${inline(library.title) || "?"}${stats ? ` (${stats})` : ""}`);
		if (inline(library.description)) lines.push(`    ${inline(library.description, 400)}`);
	}
	lines.push("", "Pass an id above as library_id to smart_search_context7_docs.");
	return join([lines.join("\n"), formatWarnings(data)]);
}

function renderCodeSnippet(snippet: Json): string {
	const code = records(snippet.codeList)
		.map((entry) => `\`\`\`${inline(entry.language)}\n${str(entry.code)}\n\`\`\``)
		.join("\n\n");
	return join([
		`### ${inline(snippet.codeTitle) || inline(snippet.pageTitle) || "Snippet"}\nSource: ${inline(snippet.codeId, 2000) || "?"}`,
		str(snippet.codeDescription),
		code,
	]);
}

function renderInfoSnippet(snippet: Json): string {
	return join([`### ${inline(snippet.breadcrumb) || inline(snippet.pageId, 2000) || "Info"}\nSource: ${inline(snippet.pageId, 2000) || "?"}`, str(snippet.content)]);
}

// 上游请求 /api/v2/context 时没带 type，拿到的是 txt：它会先包成 {"content": 文本}，再整体 json.dumps 进 content
// （context7.py:97-110, 143-145）。有结构化片段时逐条渲染，否则解开这一层 JSON
export function formatContext7Docs(data: Json): string {
	const code = records(data.code_snippets).map(renderCodeSnippet);
	const info = records(data.info_snippets).map(renderInfoSnippet);
	let body = [...code, ...info].join("\n\n");
	if (!body) {
		body = str(data.content);
		try {
			const inner: unknown = JSON.parse(body);
			if (isRecord(inner) && typeof inner.content === "string") body = inner.content;
		} catch {
			// 不是 JSON，原样使用
		}
	}
	return join([
		`Context7 docs for ${inline(data.library_id)}${str(data.query) ? ` (query: ${inline(data.query)})` : ""}`,
		formatWarnings(data),
		body || "(no documentation returned)",
	]);
}

// plan 里的 steps[].command 是写到公共 /tmp 的 CLI 命令行，会诱导模型用 bash 直接跑，去掉后改用对应的 smart_search_* 工具
const PLAN_DROPPED_KEYS = new Set(["command", "output_path", "evidence_dir"]);

function dropPlanKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(dropPlanKeys);
	if (!isRecord(value)) return value;
	return Object.fromEntries(Object.entries(value).filter(([key]) => !PLAN_DROPPED_KEYS.has(key)).map(([key, item]) => [key, dropPlanKeys(item)]));
}

export function formatPlan(data: Json): string {
	return join([json(dropPlanKeys(data)), "Carry out the steps with the smart_search_* tools (for example tool=search → smart_search_search)."]);
}

// route 等：有 content 就给正文，否则给 JSON
export function formatGeneric(data: Json): string {
	return join([formatWarnings(data), str(data.content) || json(data)]);
}
