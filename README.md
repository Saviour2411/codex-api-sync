# codex-api-sync

用于切换 Codex Responses API 提供商的本地 Web 和 CLI 工具，修改配置时会保留无关的 Codex 配置项。

工具会把每个提供商的 API key 写入对应 `[model_providers.<id>]` 的
`experimental_bearer_token` 字段，不再修改 `auth.json`。切换提供商时只会更新顶层
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
