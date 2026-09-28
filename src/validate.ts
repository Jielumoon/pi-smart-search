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
	if (family === 4) return isPrivateIPv4(host);
	if (family === 6) return isPrivateIPv6(host);
	return false;
}

function isPrivateIPv4(ip: string): boolean {
	const [a, b] = ip.split(".").map(Number);
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168)
	);
}

function isPrivateIPv6(ip: string): boolean {
	// IPv4 映射地址会被 URL 规范成 ::ffff:7f00:1 这种十六进制形式
	const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
	if (mapped) {
		const high = parseInt(mapped[1], 16);
		const low = parseInt(mapped[2], 16);
		return isPrivateIPv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
	}
	if (ip === "::" || ip === "::1") return true;
	const first = parseInt(ip.split(":")[0] || "0", 16);
	return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}
