#!/usr/bin/env node
import { startServer } from "./server.js";
import { getCodexHome } from "./platform.js";
import {
  addProvider,
  doctor,
  ensureActiveProviderSessions,
  listProviders,
  removeProvider,
  switchDefaultProvider,
  switchProvider,
  updateProvider,
} from "./provider-store.js";
import { syncSessions } from "./session-sync.js";

type ParsedArgs = {
  command: string;
  flags: Record<string, string | boolean>;
};

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) {
      throw new Error(`无法识别的参数：'${token}'。`);
    }

    const raw = token.slice(2);
    if (raw.includes("=")) {
      const [key, ...parts] = raw.split("=");
      flags[key] = parts.join("=");
      continue;
    }

    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      flags[raw] = true;
    } else {
      flags[raw] = next;
      i += 1;
    }
  }

  return { command, flags };
}

function stringFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

function requiredFlag(flags: Record<string, string | boolean>, key: string): string {
  const value = stringFlag(flags, key);
  if (!value) {
    throw new Error(`缺少必填参数 --${key}。`);
  }

  return value;
}

function printHelp(): void {
  console.log(`codex-api-sync

用法：
  codex-api-sync web [--host 127.0.0.1] [--port 14567] [--codex-home <path>]
  codex-api-sync list [--codex-home <path>]
  codex-api-sync doctor [--codex-home <path>]
  codex-api-sync add --name <name> --base-url <url> --api-key <key> [--model <model>]
  codex-api-sync update --name <name> [--new-name <name>] [--base-url <url>] [--api-key <key>] [--model <model>]
  codex-api-sync remove --name <name> [--no-sync]
  codex-api-sync switch --name <name> [--model <model>] [--no-sync]
  codex-api-sync switch-default [--model <model>] [--no-sync]
  codex-api-sync sync
`);
}

function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([provider, count]) => `${provider}:${count}`)
    .join(", ") || "无";
}

async function runStartupRepair(codexHome: string): Promise<void> {
  const result = await ensureActiveProviderSessions(codexHome);
  if (result.repaired) {
    console.warn(`已自动修复历史会话 provider 元数据到 ${result.statusBefore.targetProviderId}。`);
  }
  if (!result.statusBefore.needsSync && !result.statusAfter?.needsSync) {
    return;
  }
  for (const warning of result.warnings) {
    console.warn(`警告：${warning}`);
  }
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const codexHome = getCodexHome(stringFlag(flags, "codex-home"));

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;

    case "web": {
      await runStartupRepair(codexHome);
      const host = stringFlag(flags, "host") ?? "127.0.0.1";
      const port = Number(stringFlag(flags, "port") ?? "14567");
      const server = await startServer({ host, port, codexHome });
      console.log(`codex-api-sync web 正在监听 http://${server.host}:${server.port}`);
      return;
    }

    case "list": {
      await runStartupRepair(codexHome);
      const providers = await listProviders(codexHome);
      if (providers.length === 0) {
        console.log("还没有配置自定义提供商。");
        return;
      }

      for (const provider of providers) {
        console.log(`${provider.isActive ? "*" : " "} ${provider.name} (${provider.id}) ${provider.baseUrl} ${provider.hasApiKey ? "key:有" : "key:无"}`);
      }
      return;
    }

    case "doctor": {
      const result = await doctor(codexHome);
      console.log(`Codex Home: ${result.codexHome}`);
      console.log(`当前 provider: ${result.activeProviderId ?? "openai"}`);
      if (result.activeProvider) {
        console.log(`base_url: ${result.activeProvider.baseUrl}`);
        console.log(`experimental_bearer_token: ${result.activeProvider.hasApiKey ? "有" : "无"}`);
      }
      if (result.sessionSync) {
        console.log(`会话文件 provider 分布: ${formatCounts(result.sessionSync.statusAfter?.sessionFiles ?? result.sessionSync.statusBefore.sessionFiles)}`);
        console.log(`SQLite provider 分布: ${formatCounts(result.sessionSync.statusAfter?.sqlite ?? result.sessionSync.statusBefore.sqlite)}`);
        console.log(`会话同步状态: ${result.sessionSync.statusAfter?.needsSync ?? result.sessionSync.statusBefore.needsSync ? "仍需同步" : "正常"}`);
      }
      for (const problem of result.problems) {
        console.error(`问题：${problem}`);
      }
      for (const warning of result.warnings) {
        console.warn(`警告：${warning}`);
      }
      if (result.problems.length > 0) {
        process.exitCode = 1;
      }
      return;
    }

    case "add": {
      const provider = await addProvider(codexHome, {
        name: requiredFlag(flags, "name"),
        baseUrl: requiredFlag(flags, "base-url"),
        apiKey: requiredFlag(flags, "api-key"),
        model: stringFlag(flags, "model"),
      });
      console.log(`已添加提供商 ${provider.name} (${provider.id})。`);
      return;
    }

    case "update": {
      const provider = await updateProvider(codexHome, requiredFlag(flags, "name"), {
        name: stringFlag(flags, "new-name"),
        baseUrl: stringFlag(flags, "base-url"),
        apiKey: stringFlag(flags, "api-key"),
        model: stringFlag(flags, "model"),
      });
      console.log(`已更新提供商 ${provider.name} (${provider.id})。`);
      return;
    }

    case "remove": {
      await runStartupRepair(codexHome);
      const result = await removeProvider(codexHome, requiredFlag(flags, "name"), {
        sync: flags["no-sync"] !== true,
      });
      console.log(result.restoredDefault ? "已删除提供商，并恢复官方 OpenAI 默认配置。" : "已删除提供商。");
      for (const warning of result.sync?.warnings ?? []) {
        console.warn(`警告：${warning}`);
      }
      return;
    }

    case "switch": {
      await runStartupRepair(codexHome);
      const result = await switchProvider(codexHome, requiredFlag(flags, "name"), {
        sync: flags["no-sync"] !== true,
        model: stringFlag(flags, "model"),
      });
      console.log(`已切换到提供商 ${result.provider.name}。`);
      for (const warning of result.warnings) {
        console.warn(`警告：${warning}`);
      }
      return;
    }

    case "switch-default": {
      await runStartupRepair(codexHome);
      const result = await switchDefaultProvider(codexHome, {
        sync: flags["no-sync"] !== true,
        model: stringFlag(flags, "model"),
      });
      console.log(`已切换到默认提供商 ${result.provider.name}。`);
      for (const warning of result.warnings) {
        console.warn(`警告：${warning}`);
      }
      return;
    }

    case "sync": {
      await runStartupRepair(codexHome);
      const result = await syncSessions(codexHome);
      console.log(`会话同步完成。变更文件数：${result.changedFiles.length}，SQLite 更新行数：${result.sqliteRowsUpdated}，项目缓存：${result.globalStateUpdated ? "已更新" : "未变更"}。`);
      for (const warning of result.warnings) {
        console.warn(`警告：${warning}`);
      }
      return;
    }

    default:
      throw new Error(`未知命令：'${command}'。请运行 codex-api-sync help。`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
