import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./fs-utils.js";
import { readCodexConfig } from "./codex-config.js";
import type { SyncResult } from "./types.js";

async function collectJsonlFiles(dir: string): Promise<string[]> {
  if (!(await pathExists(dir))) {
    return [];
  }

  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return collectJsonlFiles(fullPath);
    }

    return entry.isFile() && entry.name.endsWith(".jsonl") ? [fullPath] : [];
  }));

  return files.flat();
}

async function touchIfExists(filePath: string, warnings: string[]): Promise<boolean> {
  if (!(await pathExists(filePath))) {
    warnings.push(`未找到 ${path.basename(filePath)}，已跳过。`);
    return false;
  }

  return true;
}

function syncJsonlContent(content: string, providerId: string, fromProviderId?: string): { content: string; changed: boolean } {
  const lines = content.match(/[^\n]*\n|[^\n]+/g) ?? [];
  let changed = false;

  const nextLines = lines.map((line) => {
    const ending = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
    const body = ending ? line.slice(0, -ending.length) : line;
    if (!body.trim()) {
      return line;
    }

    try {
      const item = JSON.parse(body) as unknown;
      if (
        item &&
        typeof item === "object" &&
        (item as { type?: unknown }).type === "session_meta" &&
        (item as { payload?: unknown }).payload &&
        typeof (item as { payload: unknown }).payload === "object"
      ) {
        const payload = (item as { payload: Record<string, unknown> }).payload;
        if ((!fromProviderId || payload.model_provider === fromProviderId) && payload.model_provider !== providerId) {
          payload.model_provider = providerId;
          changed = true;
          return `${JSON.stringify(item)}${ending}`;
        }
      }
    } catch {
      return line;
    }

    return line;
  });

  return { content: nextLines.join(""), changed };
}

export async function syncSessions(codexHome: string, providerId?: string, options?: { fromProviderId?: string }): Promise<SyncResult> {
  const warnings: string[] = [];
  const changedFiles: string[] = [];
  const targetProviderId = providerId ?? (await readCodexConfig(codexHome)).activeProviderId;

  if (!targetProviderId) {
    warnings.push("未找到当前激活的 model_provider，已跳过会话元数据同步。");
  }

  const sessionsDir = path.join(codexHome, "sessions");
  const archivedDir = path.join(codexHome, "archived_sessions");
  const stateDb = path.join(codexHome, "state_5.sqlite");
  const globalState = path.join(codexHome, ".codex-global-state.json");

  const sessionFiles = [
    ...(await collectJsonlFiles(sessionsDir)),
    ...(await collectJsonlFiles(archivedDir)),
  ];

  if (sessionFiles.length === 0) {
    warnings.push("未找到会话 JSONL 文件，已跳过会话文件同步。");
  }

  for (const file of sessionFiles) {
    const content = await fs.readFile(file, "utf8");
    if (!targetProviderId || !content.includes("\"session_meta\"")) {
      continue;
    }

    const synced = syncJsonlContent(content, targetProviderId, options?.fromProviderId);
    if (synced.changed) {
      await fs.copyFile(file, `${file}.bak`);
      await fs.writeFile(file, synced.content, "utf8");
      changedFiles.push(file);
    }
  }

  await touchIfExists(stateDb, warnings);
  await touchIfExists(globalState, warnings);

  if (warnings.length > 0) {
    warnings.push("当前实现会尽力同步提供商可见性元数据。");
  }

  return { changedFiles, warnings };
}
