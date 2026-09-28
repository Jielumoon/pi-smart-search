<h1 align="center">pi-smart-search</h1>

<p align="center">通过 Smart Search CLI，为 pi 提供联网搜索、网页抓取与研究取证能力。</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-22C55E?style=flat-square" alt="License: MIT"></a>
</p>

## 特点

- **搜索、抓取与研究：** 获取附带来源链接的回答，将网页读取为 Markdown，或收集多页面证据。
- **CLI 薄适配：** 复用 [Smart Search](https://github.com/konbakuyomu/smartsearch) 的服务商配置、路由与降级能力，不维护第二套实现。
- **工具按需启用：** 核心工具默认可用，Exa、站点地图、Context7、研究规划和诊断工具按需激活。
- **结果更易阅读：** 提供耗时进度、可折叠预览；输出超出上下文限制时，保存全文供后续读取。

## 架构

```text
┌────┐    ┌─────────────────┐  spawn   ┌──────────────────┐
│ pi │───▶│ pi-smart-search │─────────▶│ smart-search CLI │
└────┘    └─────────────────┘◀─────────└──────────────────┘
                               JSON
```

扩展负责注册 pi 工具、校验输入、调用 CLI 并格式化 JSON 结果。服务商请求由 Smart Search 处理。

## 安装

前置条件：

- 已安装 pi，并配置可用的模型。
- Smart Search npm 包需要 Node.js 18+。
- 为需要使用的能力准备相应服务商凭证。

安装用于验证本适配层的 CLI 版本，并完成配置：

```bash
npm install -g @konbakuyomu/smart-search@0.1.25
smart-search setup
smart-search doctor
```

`doctor` 会发起实际连通性探测。服务商配置和凭证由 Smart Search 管理，本扩展不另建一套配置。

在本仓库的本地目录中，将扩展注册到 pi：

```bash
pi install "$PWD"
```

本地目录会继续作为包来源，请保留该目录。

## 快速开始

启动新的 pi 会话：

```bash
pi
```

输入：

```text
Use smart_search_search to find the official TypeScript handbook and cite the source URLs.
```

工具会返回回答及带编号的来源链接。实际可用结果取决于 Smart Search 的服务商配置。

如果只想临时试用、不注册到配置，可以改为在仓库根目录运行：

```bash
pi -e ./index.ts
```

## 工具

默认启用：

| 工具 | 用途 |
|---|---|
| `smart_search_search` | 联网搜索，返回回答及来源链接。 |
| `smart_search_fetch` | 将公开网页抓取为 Markdown。 |
| `smart_search_research` | 收集页面级证据，返回索引及本地文件路径。 |
| `smart_search_tools` | 为当前会话激活可选工具组。 |

可选工具组：

| 分组 | 工具 |
|---|---|
| `exa` | `smart_search_exa_search`、`smart_search_exa_similar` |
| `site_map` | `smart_search_map` |
| `context7` | `smart_search_context7_library`、`smart_search_context7_docs` |
| `planning` | `smart_search_plan`、`smart_search_route` |
| `diagnostics` | `smart_search_doctor`、`smart_search_providers` |

模型可通过 `smart_search_tools` 激活这些分组。规划和路由解释工具不调用服务商；`smart_search_doctor` 会执行实际探测。

**研究工具返回证据，不直接生成最终回答。** 模型应读取相关证据文件，自行归纳结论并引用原始 URL。索引中的搜索摘要会明确标记为未经核实。

## 配置

扩展复用 CLI 的配置，仅提供以下环境变量：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `PI_SMART_SEARCH_BIN` | `smart-search` | CLI 可执行文件或包装脚本路径。 |
| `PI_SMART_SEARCH_TIMEOUT_MS` | `600000` | 单次调用超时，单位为毫秒。 |
| `PI_SMART_SEARCH_DEFERRED_TOOLS` | 启用 | 设为 `0` 可关闭工具按需激活。 |

CLI 版本检查接受 `>=0.1.25 <0.2.0`。超出该范围时只提示警告，不阻止调用，但不保证兼容。

## 输出与隐私

- 工具输出限制为 12 KiB 或 400 行。发生截断时，扩展会尝试保存完整输出并返回文件路径。
- 研究证据和完整输出存放在系统临时目录下的 `pi-smart-search-*` 目录中。在遵循 POSIX 权限的平台上，目录权限为 `0700`，扩展写入的文件权限为 `0600`。
- 接收 URL 的工具会拒绝非 HTTP(S) 地址、内嵌凭证、localhost 和已识别的私有 IP 字面值。搜索与研究查询中的本地或私有 URL 也会受到检查。
- URL 检查不解析 DNS，也不验证重定向目标，不是网络沙箱。查询和 URL 会发送给已配置的服务商，请勿提交密钥或敏感内网地址。
- 运行进度显示已耗时，不提供逐字回答流或服务商阶段进度。

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test
```

测试覆盖 CLI 执行、输入校验、结果格式化和工具注册。真实 CLI 集成用例默认跳过。

## 许可

[MIT](./LICENSE)。

结果渲染部分改编自 [pi-search](https://github.com/justhil/pi-search)，对应许可声明保留在 `LICENSE` 中。
