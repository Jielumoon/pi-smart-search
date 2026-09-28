#!/usr/bin/env node
// 测试用假 smart-search CLI，行为由 FAKE_SMART_SEARCH_MODE 控制
import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";

const env = process.env;
const args = process.argv.slice(2);
// 记录收到的 argv，用来断言工具参数到 CLI 参数的映射
if (env.FAKE_SMART_SEARCH_ARGV_FILE) writeFileSync(env.FAKE_SMART_SEARCH_ARGV_FILE, JSON.stringify(args));

switch (env.FAKE_SMART_SEARCH_MODE ?? "echo") {
	case "echo":
		// 原样回显收到的 argv，用来验证参数顺序
		process.stdout.write(JSON.stringify({ ok: true, argv: args }));
		break;
	case "stdout":
		process.stdout.write(env.FAKE_SMART_SEARCH_STDOUT ?? "");
		process.stderr.write(env.FAKE_SMART_SEARCH_STDERR ?? "");
		process.exitCode = Number(env.FAKE_SMART_SEARCH_EXIT ?? 0);
		break;
	case "big":
		process.stdout.write("x".repeat(Number(env.FAKE_SMART_SEARCH_BYTES)));
		break;
	case "hang": {
		// 孙进程继承 stdout（和真实包装脚本一样），没杀干净的话 close 永远不会触发
		// FAKE_SMART_SEARCH_ESCAPE=1 时孙进程脱离进程组，模拟进程树杀不干净
		const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			stdio: ["ignore", "inherit", "inherit"],
			detached: Boolean(env.FAKE_SMART_SEARCH_ESCAPE),
		});
		if (env.FAKE_SMART_SEARCH_IGNORE_TERM) process.on("SIGTERM", () => {});
		// 先写临时文件再改名：测试一看到文件就读，不能读到写了一半的内容
		writeFileSync(`${env.FAKE_SMART_SEARCH_PIDFILE}.tmp`, `${process.pid} ${grandchild.pid}`);
		renameSync(`${env.FAKE_SMART_SEARCH_PIDFILE}.tmp`, env.FAKE_SMART_SEARCH_PIDFILE);
		setInterval(() => {}, 1000);
		break;
	}
	default:
		process.stderr.write(`unknown FAKE_SMART_SEARCH_MODE: ${env.FAKE_SMART_SEARCH_MODE}\n`);
		process.exitCode = 99;
}
