# codex-api-sync

用于切换 Codex Responses API 提供商的本地 Web 和 CLI 工具，修改配置时会保留无关的 Codex 配置项。

工具会把每个提供商的 API key 写入对应 `[model_providers.<id>]` 的
`experimental_bearer_token` 字段，并在 provider 块里显式写入
`requires_openai_auth = false`，不再修改 `auth.json`。切换提供商时只会更新顶层
`preferred_auth_method`、`requires_openai_auth` 和 `model_provider`。

官方文档把 `experimental_bearer_token` 标为实验字段；这里采用它是因为实测兼容性更好，且可以避免修改全局 `auth.json`。

## 使用

```sh
npm install
npm run build
node dist/cli.js list
node dist/cli.js add --name any --base-url https://example.com/v1 --api-key sk-...
node dist/cli.js switch --name any
node dist/cli.js web
```

默认使用 `$CODEX_HOME` 指向的目录；未设置时使用 `~/.codex`。

## 命令

```sh
codex-api-sync web [--host 127.0.0.1] [--port 14567] [--codex-home <path>]
codex-api-sync list [--codex-home <path>]
codex-api-sync doctor [--codex-home <path>]
codex-api-sync add --name <name> --base-url <url> --api-key <key> [--model <model>]
codex-api-sync update --name <name> [--new-name <name>] [--base-url <url>] [--api-key <key>] [--model <model>]
codex-api-sync remove --name <name> [--no-sync]
codex-api-sync switch --name <name> [--model <model>] [--no-sync]
codex-api-sync switch-default [--model <model>] [--no-sync]
codex-api-sync sync
```

删除最后一个自定义提供商时，工具会删除顶层 `preferred_auth_method`、`requires_openai_auth` 和 `model_provider`，让 Codex 回到官方默认 provider 路径。
也可以用 `switch-default` 或 Web 页面里的“默认 OpenAI”按钮手动切回默认 provider，而不删除任何自定义提供商。
删除任意提供商时，工具会先把历史会话中引用该提供商的 `model_provider` 改为 `openai`，避免 Codex 打开历史会话时报 provider 不存在。

## 会话同步

切换 provider 时默认会同步：

- `sessions` 和 `archived_sessions` 下 rollout JSONL 第一行 `session_meta.payload.model_provider`
- `state_5.sqlite` 的 `threads.model_provider`，以及可用时的 `threads.cwd`
- `.codex-global-state.json` 和 `.codex-global-state.json.bak` 中的桌面版 workspace roots 缓存

工具启动 Web、执行 `list`、`doctor`、`sync`、`switch`、`switch-default`、`remove` 时，会先检查当前 active provider 与历史会话 provider 元数据是否一致；如果当前已启用第三方 provider 但历史里仍残留 `openai` 或旧 provider，会自动同步到当前 provider。

SQLite 同步会优先使用 Node.js 内置 `node:sqlite`；在 Node 20 等没有内置 SQLite 的环境下，会自动使用 `node-sqlite3-wasm` 后备实现，不需要系统安装 `sqlite3` 命令或原生编译工具。
