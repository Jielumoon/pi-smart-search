# smart-search CLI 契约样本

采集：2026-09-27，`smart-search 0.1.25`（npm `@konbakuyomu/smart-search`，linux-x64），WSL2 + Node v24.19.0。

处理规则：超过 2000 字符的字符串截断并标注原长；中转地址替换为 `https://relay.example`，家目录替换为 `/home/user`；已确认不含密钥（doctor 自带掩码）。

| 文件 | 命令 | 退出码 | 耗时 |
|---|---|---|---|
| `doctor.config_error.json` | `doctor --format json`（未配置任何 provider） | 3 | 0.2s |
| `doctor.ok.json` | `doctor --format json`（xAI 中转 + Exa + Tavily + Firecrawl） | 0 | 9.7s（含连通性探测） |
| `search.ok.json` | `search "<node:sqlite 问题>" --format json` | 0 | 29.1s（`grok-4.20-multi-agent-xhigh`） |
| `fetch.ok.json` | `fetch <pi extensions.md raw URL> --format json` | 0 | 1.7s |
| `fetch.parameter_error.json` | `fetch "not-a-url" --format json`（CLI 不做本地校验，真的发给了 Tavily/Firecrawl） | 2 | 3.0s |
| `research.ok.json` | `research "<pi onUpdate 问题>" --budget quick --format json`（原始 stdout 272KB，主要是 `evidence_items`） | 0 | 21.5s |
| `research.argparse_error.stderr.txt` | `research "x" --budget nope --format json`：**stdout 为空**，只有 stderr 文本 | 2 | 0.3s |

`smart-search --version` 冷启动约 0.18s。
