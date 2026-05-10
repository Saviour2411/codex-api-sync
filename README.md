# codex-api-sync

用于切换 Codex Responses API 提供商的本地 Web 和 CLI 工具，修改配置时会保留无关的 Codex 配置项。

工具会把每个提供商的 API key 存在 `auth.json` 中，字段名类似
`CODEX_PROVIDER_ANY_API_KEY`。切换提供商时，工具会把选中的 key 复制到
`OPENAI_API_KEY`，因为 Codex 对 `requires_openai_auth = true` 的提供商会读取这个认证字段。

添加第一个受管提供商前，工具会用私有字段保存原始 `OPENAI_API_KEY` 状态。删除最后一个受管提供商时，会恢复原始 key；如果原来不存在，则把 `OPENAI_API_KEY` 保留为空字符串。

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
codex-api-sync remove --name <name>
codex-api-sync switch --name <name> [--model <model>] [--no-sync]
codex-api-sync sync
```

删除最后一个自定义提供商时，工具会删除自定义 `model_provider` 和 `preferred_auth_method`，让 Codex 回到官方 OpenAI provider 路径。
