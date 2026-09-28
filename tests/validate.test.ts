import { describe, expect, it } from "vitest";
import { SmartSearchError } from "../src/runner.ts";
import { assertNoPrivateUrls, isPrivateHost, MAX_INPUT_BYTES, normalizePublicUrl, normalizeText } from "../src/validate.ts";

function invalidInput(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(SmartSearchError);
		expect((error as SmartSearchError).type).toBe("invalid_input");
		return (error as SmartSearchError).message;
	}
	throw new Error("expected invalid_input");
}

describe("normalizeText", () => {
	it("去掉首尾空白", () => {
		expect(normalizeText("  hello  ", "query")).toBe("hello");
	});

	it.each([
		["非字符串", 42],
		["空白", "   "],
		["含 NUL", "a\0b"],
		["超过字节上限（按 UTF-8 计）", "字".repeat(Math.floor(MAX_INPUT_BYTES / 3) + 1)],
	])("拒绝%s", (_name, value) => {
		expect(invalidInput(() => normalizeText(value, "query"))).toMatch(/^\[invalid_input\] query /);
	});

	it("正好等于字节上限时放行", () => {
		expect(normalizeText("a".repeat(MAX_INPUT_BYTES), "query")).toHaveLength(MAX_INPUT_BYTES);
	});
});

describe("normalizePublicUrl", () => {
	it.each([
		["https://example.com/a?b=1", "https://example.com/a?b=1"],
		["  http://EXAMPLE.com  ", "http://example.com/"],
		["https://8.8.8.8/", "https://8.8.8.8/"],
		["https://172.32.0.1/", "https://172.32.0.1/"],
		["https://100.128.0.1/", "https://100.128.0.1/"],
		["https://[64:ff9b::808:808]/", "https://[64:ff9b::808:808]/"],
		["https://[2001:db8::1]/", "https://[2001:db8::1]/"],
		["https://localhost.example.com/", "https://localhost.example.com/"],
	])("放行公网地址 %s", (input, expected) => {
		expect(normalizePublicUrl(input)).toBe(expected);
	});

	it.each([
		["相对地址", "/docs"],
		["非 http(s)", "ftp://example.com/"],
		["file 协议", "file:///etc/passwd"],
		["带用户名密码", "https://user:pass@example.com/"],
	])("拒绝%s", (_name, input) => {
		invalidInput(() => normalizePublicUrl(input));
	});

	it.each([
		"http://localhost:3000/admin?token=x",
		"http://LOCALHOST./",
		"http://api.localhost/",
		"http://127.0.0.1/",
		"http://127.1/",
		"http://0x7f000001/",
		"http://2130706433/",
		"http://0.0.0.0/",
		"http://10.1.2.3/",
		"http://172.16.0.1/",
		"http://172.31.255.255/",
		"http://192.168.1.1/",
		"http://169.254.169.254/latest/meta-data/",
		"http://[::1]/",
		"http://[::]/",
		"http://[::ffff:127.0.0.1]/",
		"http://[::ffff:192.168.0.1]/",
		"http://[fd00::1]/",
		"http://[fc00::1]/",
		"http://[fe80::1]/",
		"http://100.64.0.1/",
		"http://100.127.255.255/",
		"http://[::ffff:0:127.0.0.1]/",
		"http://[::127.0.0.1]/",
		"http://[64:ff9b::7f00:1]/",
		"http://[64:ff9b::a00:1]/",
	])("拒绝内网或本机地址 %s", (input) => {
		expect(invalidInput(() => normalizePublicUrl(input))).toContain("private network");
	});

	it("错误信息使用传入的参数名", () => {
		expect(invalidInput(() => normalizePublicUrl("nope", "seed_url"))).toContain("seed_url must be an absolute");
	});
});

describe("assertNoPrivateUrls", () => {
	it.each([
		"summarize http://192.168.1.1/admin?token=abc",
		"看下 http://localhost:3000/。",
		"(see http://127.0.0.1:8080)",
		"两个地址：https://example.com/ 和 http://10.0.0.1/",
	])("拒绝夹带内网 URL 的 query：%s", (query) => {
		const message = invalidInput(() => assertNoPrivateUrls(query, "query"));
		expect(message).toContain("query contains a local or private network URL");
		expect(message).not.toContain("token=abc");
	});

	it.each([
		"what is localhost",
		"summarize https://example.com/a?b=1",
		// 上游的提取规则区分大小写，大写协议不会被抓取
		"HTTP://127.0.0.1 status code meaning",
		"http:// 是什么",
	])("放行：%s", (query) => {
		expect(assertNoPrivateUrls(query, "query")).toBe(query);
	});
});

describe("isPrivateHost", () => {
	it("普通域名不做 DNS 解析，直接放行", () => {
		expect(isPrivateHost("intranet.corp")).toBe(false);
	});
});
