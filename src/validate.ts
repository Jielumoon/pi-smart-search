// 本地输入校验：不通过时抛 invalid_input，根本不启动 CLI
import { isIP } from "node:net";
import { SmartSearchError } from "./runner.ts";

export const MAX_INPUT_BYTES = 8192;

function invalid(message: string): SmartSearchError {
	return new SmartSearchError("invalid_input", message);
}

export function normalizeText(value: unknown, label: string): string {
	if (typeof value !== "string") throw invalid(`${label} must be a string.`);
	const text = value.trim();
	if (!text) throw invalid(`${label} must not be empty.`);
	if (text.includes("\0")) throw invalid(`${label} must not contain NUL bytes.`);
	if (Buffer.byteLength(text, "utf8") > MAX_INPUT_BYTES) {
		throw invalid(`${label} exceeds the ${MAX_INPUT_BYTES}-byte limit.`);
	}
	return text;
}

// URL 会被转交给 Tavily/Firecrawl/Exa 等第三方抓取，内网地址它们访问不到，传过去只会泄露地址和 token
export function normalizePublicUrl(value: unknown, label = "url"): string {
	const text = normalizeText(value, label);
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		throw invalid(`${label} must be an absolute http(s) URL.`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw invalid(`${label} must use http or https.`);
	if (url.username || url.password) throw invalid(`${label} must not include credentials.`);
	if (isPrivateHost(url.hostname)) {
		throw invalid(
			`${label} points to a local or private network address. Smart Search forwards URLs to third-party providers, which cannot reach it.`,
		);
	}
	return url.href;
}

// 只看字面值，不做 DNS 解析；WHATWG URL 已把 127.1、0x7f000001 这类写法规范成点分十进制
export function isPrivateHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
	if (host === "localhost" || host.endsWith(".localhost")) return true;
	const family = isIP(host);
	if (family === 4) return isPrivateIPv4(host.split(".").map(Number));
	if (family === 6) return isPrivateIPv6(ipv6Groups(host));
	return false;
}

function isPrivateIPv4([a, b]: number[]): boolean {
	return (
		a === 0 ||
		a === 10 ||
		(a === 100 && b >= 64 && b <= 127) || // CGNAT，Tailscale 等也用这一段
		a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168)
	);
}

// 展开成 8 个 16 位分组；URL 规范化后的 IPv6 不含点分部分，这里顺带兼容 isIP 接受的 ::a.b.c.d 写法
function ipv6Groups(ip: string): number[] {
	const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
	let text = ip;
	if (dotted) {
		const [a, b, c, d] = dotted[1].split(".").map(Number);
		text = `${ip.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	const [head, tail] = text.split("::");
	const left = head ? head.split(":") : [];
	const right = tail ? tail.split(":") : [];
	const fill = tail === undefined ? [] : Array(8 - left.length - right.length).fill("0");
	return [...left, ...fill, ...right].map((group) => parseInt(group, 16));
}

function isPrivateIPv6(g: number[]): boolean {
	const zeros = (from: number, to: number) => g.slice(from, to).every((group) => group === 0);
	// 内嵌 IPv4 的几种写法：映射 ::ffff:0:0/96、转换 ::ffff:0:0:0/96、兼容 ::/96、NAT64 64:ff9b::/96
	const embedsIPv4 =
		(zeros(0, 5) && g[5] === 0xffff) ||
		(zeros(0, 4) && g[4] === 0xffff && g[5] === 0) ||
		(zeros(0, 6) && !(g[6] === 0 && g[7] <= 1)) ||
		(g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6));
	if (embedsIPv4) return isPrivateIPv4([g[6] >> 8, g[6] & 255]);
	if (zeros(0, 7) && g[7] <= 1) return true; // :: 与 ::1
	return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80;
}

// 上游会从 search/research 的 query 里提取 URL 再去抓取（intent_router.py 的 extract_urls），用同一条规则检查
const QUERY_URL = /https?:\/\/[^\s<>\])"'，。；！？、：）】》」』]+/g;

export function assertNoPrivateUrls(text: string, label: string): string {
	for (const [match] of text.matchAll(QUERY_URL)) {
		let host: string;
		try {
			host = new URL(match.replace(/[.,;，。；)]+$/, "")).hostname;
		} catch {
			continue;
		}
		if (isPrivateHost(host)) {
			throw invalid(
				`${label} contains a local or private network URL (${host}). Smart Search would try to fetch it through third-party providers, which cannot reach it; remove the URL from ${label}.`,
			);
		}
	}
	return text;
}
