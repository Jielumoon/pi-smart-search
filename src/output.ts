// 私有输出目录与给模型看的截断：目录 0700、文件 0600，不写进共享的 /tmp 公共路径
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatSize, truncateHead } from "@earendil-works/pi-coding-agent";

export const MODEL_MAX_BYTES = 12 * 1024;
export const MODEL_MAX_LINES = 400;

let root: string | undefined;

// 每个进程第一次需要时创建；mkdtemp 用随机名并以 0700 创建，别人没法抢注或读取。
// 目录可能被 tmp 清理程序删掉，每次用之前确认还在，不在就重建
export async function privateRoot(): Promise<string> {
	if (root && existsSync(root)) return root;
	root = await mkdtemp(join(tmpdir(), "pi-smart-search-"));
	return root;
}

export async function makePrivateDir(prefix: string): Promise<string> {
	return mkdtemp(join(await privateRoot(), `${prefix}-`));
}

export async function writePrivateFile(dir: string, name: string, content: string): Promise<string> {
	const file = join(dir, name);
	await writeFile(file, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
	return file;
}

function sliceUtf8(text: string, maxBytes: number): string {
	return Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/, "");
}

export interface ModelText {
	text: string;
	fullOutputPath?: string;
}

export async function truncateForModel(text: string, prefix: string): Promise<ModelText> {
	const result = truncateHead(text, { maxBytes: MODEL_MAX_BYTES, maxLines: MODEL_MAX_LINES });
	if (!result.truncated) return { text };
	// truncateHead 只保留完整行：遇到超长的一行（网页正文常常整篇一行）就停下，可能只剩表头甚至空串，
	// 所以按字节超限时直接按字节截取
	const head = result.truncatedBy === "bytes" ? sliceUtf8(text, MODEL_MAX_BYTES) : result.content;
	const shown = `${formatSize(Buffer.byteLength(head, "utf8"))} of ${formatSize(result.totalBytes)}`;
	let fullOutputPath: string | undefined;
	try {
		const name = `${prefix}-${Date.now()}-${randomBytes(3).toString("hex")}.md`;
		fullOutputPath = await writePrivateFile(await privateRoot(), name, text);
	} catch {
		// 落盘失败时仍返回截断内容，只是没有完整文件路径
	}
	const notice = fullOutputPath
		? `[Output truncated: showing ${shown}. Full output saved to: ${fullOutputPath}]`
		: `[Output truncated: showing ${shown}. The full output could not be saved.]`;
	return { text: `${head}\n\n${notice}`, fullOutputPath };
}
