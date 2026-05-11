import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./fs-utils.js";
import { readCodexConfig } from "./codex-config.js";
import type { SyncResult } from "./types.js";

type SqliteDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => {
    run?: (...values: unknown[]) => { changes?: number | bigint };
    all?: (...values: unknown[]) => Array<Record<string, unknown>>;
  };
  close: () => void;
};

type SqliteModule = {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
};

type CwdStat = {
  cwd: string;
  normalizedCwd: string;
  count: number;
  updatedAtMs: number;
};

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

function parseSessionMetaLine(line: string): { item: Record<string, unknown>; payload: Record<string, unknown> } | undefined {
  try {
    const item = JSON.parse(line) as unknown;
    if (
      item &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "session_meta" &&
      (item as { payload?: unknown }).payload &&
      typeof (item as { payload: unknown }).payload === "object" &&
      !Array.isArray((item as { payload: unknown }).payload)
    ) {
      return {
        item: item as Record<string, unknown>,
        payload: (item as { payload: Record<string, unknown> }).payload,
      };
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function splitFirstLine(content: string): { firstLine: string; ending: string; rest: string } {
  const newlineIndex = content.indexOf("\n");
  if (newlineIndex === -1) {
    return { firstLine: content, ending: "", rest: "" };
  }

  const hasCarriageReturn = newlineIndex > 0 && content[newlineIndex - 1] === "\r";
  const firstLine = content.slice(0, hasCarriageReturn ? newlineIndex - 1 : newlineIndex);
  const ending = hasCarriageReturn ? "\r\n" : "\n";
  return { firstLine, ending, rest: content.slice(newlineIndex + 1) };
}

function syncJsonlContent(content: string, providerId: string, fromProviderId?: string): { content: string; changed: boolean; threadId?: string; cwd?: string } {
  const { firstLine, ending, rest } = splitFirstLine(content);
  const parsed = parseSessionMetaLine(firstLine);
  if (!parsed) {
    return { content, changed: false };
  }

  const currentProvider = parsed.payload.model_provider;
  const threadId = typeof parsed.payload.id === "string" && parsed.payload.id ? parsed.payload.id : undefined;
  const cwd = typeof parsed.payload.cwd === "string" && parsed.payload.cwd.trim() ? parsed.payload.cwd : undefined;
  if ((fromProviderId && currentProvider !== fromProviderId) || currentProvider === providerId) {
    return { content, changed: false, threadId, cwd };
  }

  parsed.payload.model_provider = providerId;
  return {
    content: `${JSON.stringify(parsed.item)}${ending}${rest}`,
    changed: true,
    threadId,
    cwd,
  };
}

function getBuiltinModule(moduleName: string): unknown {
  return (process as unknown as { getBuiltinModule?: (name: string) => unknown }).getBuiltinModule?.(moduleName);
}

async function loadSqlite(warnings: string[]): Promise<SqliteModule | undefined> {
  const builtin = getBuiltinModule("node:sqlite");
  if (builtin && typeof builtin === "object" && "DatabaseSync" in builtin) {
    return builtin as SqliteModule;
  }

  try {
    const dynamicImport = new Function("moduleName", "return import(moduleName)") as (moduleName: string) => Promise<unknown>;
    return await dynamicImport("node:sqlite") as SqliteModule;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ERR_UNKNOWN_BUILTIN_MODULE" || code === "ERR_MODULE_NOT_FOUND") {
      warnings.push("当前 Node.js 不支持 node:sqlite，已跳过 state_5.sqlite 同步。建议使用 Node.js 24 或更高版本运行同步。");
      return undefined;
    }

    throw error;
  }
}

function tableHasColumn(db: SqliteDatabase, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info("${tableName.replaceAll("\"", "\"\"")}")`).all?.() ?? [];
  return rows.some((row) => row.name === columnName);
}

function normalizeComparablePath(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  let normalized = value.trim();
  if (!normalized) {
    return undefined;
  }

  const extendedUnc = normalized.match(/^\\\\\?\\UNC\\(.+)$/i);
  normalized = extendedUnc ? `\\\\${extendedUnc[1]}` : normalized.replace(/^\\\\\?\\/, "");
  normalized = normalized.replace(/\//g, "\\");
  normalized = normalized.replace(/\\+$/, "");
  if (/^[A-Za-z]:$/.test(normalized)) {
    normalized += "\\";
  }

  return normalized.toLowerCase();
}

function toDesktopWorkspacePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }

  const extendedUnc = trimmed.match(/^\\\\\?\\UNC\\(.+)$/i);
  if (extendedUnc) {
    return `\\\\${extendedUnc[1]}`.replace(/\//g, "\\");
  }

  const extendedDrive = trimmed.match(/^\\\\\?\\([A-Za-z]:)(?:[\\/](.*))?$/);
  if (extendedDrive) {
    const [, drive, rest] = extendedDrive;
    return rest ? `${drive}\\${rest.replace(/\//g, "\\")}` : `${drive}\\`;
  }

  if (trimmed.startsWith("\\\\?\\")) {
    return trimmed.slice(4).replace(/\//g, "\\");
  }

  return value;
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of paths) {
    const comparable = normalizeComparablePath(value);
    if (!comparable || seen.has(comparable)) {
      continue;
    }

    seen.add(comparable);
    result.push(value);
  }

  return result;
}

function toPathArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  }

  return typeof value === "string" && value.trim() ? [value] : [];
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function resolveStoredPath(value: string, cwdStats: CwdStat[]): string {
  const comparable = normalizeComparablePath(value);
  if (!comparable) {
    return value;
  }

  const matches = cwdStats.filter((entry) => entry.normalizedCwd === comparable);
  if (matches.length === 0) {
    return toDesktopWorkspacePath(value);
  }

  matches.sort((left, right) => (
    (right.count - left.count) ||
    (right.updatedAtMs - left.updatedAtMs) ||
    left.cwd.localeCompare(right.cwd)
  ));
  return toDesktopWorkspacePath(matches[0].cwd);
}

function copyResolvedObjectKeys(input: unknown, cwdStats: CwdStat[]): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const resolved = resolveStoredPath(key, cwdStats);
    if (result[resolved] === undefined || resolved === key) {
      result[resolved] = value;
    }
  }

  return result;
}

async function readThreadCwdStats(codexHome: string, sqlite: SqliteModule, warnings: string[]): Promise<CwdStat[]> {
  const dbPath = path.join(codexHome, "state_5.sqlite");
  if (!(await pathExists(dbPath))) {
    return [];
  }

  let db: SqliteDatabase | undefined;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    if (!tableHasColumn(db, "threads", "cwd")) {
      return [];
    }

    const updatedAtExpression = tableHasColumn(db, "threads", "updated_at_ms") ? "COALESCE(MAX(updated_at_ms), 0)" : "0";
    const rows = db.prepare(`
      SELECT cwd, COUNT(*) AS count, ${updatedAtExpression} AS updated_at_ms
      FROM threads
      WHERE cwd IS NOT NULL AND cwd <> ''
      GROUP BY cwd
      ORDER BY count DESC, updated_at_ms DESC, cwd
    `).all?.() ?? [];

    return rows
      .filter((row) => typeof row.cwd === "string" && row.cwd)
      .map((row) => ({
        cwd: row.cwd as string,
        normalizedCwd: normalizeComparablePath(row.cwd) ?? "",
        count: Number(row.count) || 0,
        updatedAtMs: Number(row.updated_at_ms) || 0,
      }))
      .filter((row) => row.normalizedCwd);
  } catch (error) {
    warnings.push(`读取 state_5.sqlite cwd 信息失败，已跳过 workspace roots 修复：${error instanceof Error ? error.message : String(error)}`);
    return [];
  } finally {
    db?.close();
  }
}

async function updateSqliteProvider(
  codexHome: string,
  providerId: string,
  sqlite: SqliteModule,
  warnings: string[],
  options?: { fromProviderId?: string; threadCwdById?: Map<string, string> }
): Promise<{ present: boolean; rowsUpdated: number }> {
  const dbPath = path.join(codexHome, "state_5.sqlite");
  if (!(await pathExists(dbPath))) {
    warnings.push("未找到 state_5.sqlite，已跳过 SQLite 会话索引同步。");
    return { present: false, rowsUpdated: 0 };
  }

  let db: SqliteDatabase | undefined;
  let transactionOpen = false;
  try {
    db = new sqlite.DatabaseSync(dbPath);
    if (!tableHasColumn(db, "threads", "model_provider")) {
      warnings.push("state_5.sqlite 的 threads 表没有 model_provider 字段，已跳过 SQLite provider 同步。");
      return { present: true, rowsUpdated: 0 };
    }

    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const result = options?.fromProviderId
      ? db.prepare(`
          UPDATE threads
          SET model_provider = ?
          WHERE model_provider = ?
        `).run?.(providerId, options.fromProviderId)
      : db.prepare(`
          UPDATE threads
          SET model_provider = ?
          WHERE COALESCE(model_provider, '') <> ?
        `).run?.(providerId, providerId);
    let cwdRowsUpdated = 0;
    if (tableHasColumn(db, "threads", "cwd") && options?.threadCwdById?.size) {
      const cwdStmt = db.prepare(`
        UPDATE threads
        SET cwd = ?
        WHERE id = ? AND COALESCE(cwd, '') <> ?
      `);
      for (const [threadId, cwd] of options.threadCwdById) {
        const desktopCwd = toDesktopWorkspacePath(cwd);
        cwdRowsUpdated += Number(cwdStmt.run?.(desktopCwd, threadId, desktopCwd).changes ?? 0);
      }
    }
    db.exec("COMMIT");
    transactionOpen = false;

    return { present: true, rowsUpdated: Number(result?.changes ?? 0) + cwdRowsUpdated };
  } catch (error) {
    if (transactionOpen) {
      try {
        db?.exec("ROLLBACK");
      } catch {
        // 回滚失败时保留原始错误信息。
      }
    }
    warnings.push(`同步 state_5.sqlite 失败，请关闭 Codex / Codex App 后重试：${error instanceof Error ? error.message : String(error)}`);
    return { present: true, rowsUpdated: 0 };
  } finally {
    db?.close();
  }
}

async function syncGlobalState(codexHome: string, cwdStats: CwdStat[], warnings: string[]): Promise<boolean> {
  const filePath = path.join(codexHome, ".codex-global-state.json");
  const backupPath = path.join(codexHome, ".codex-global-state.json.bak");
  if (!(await pathExists(filePath))) {
    warnings.push("未找到 .codex-global-state.json，已跳过项目路径缓存同步。");
    return false;
  }

  let state: Record<string, unknown>;
  try {
    state = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    warnings.push(`读取 .codex-global-state.json 失败，已跳过项目路径缓存同步：${error instanceof Error ? error.message : String(error)}`);
    return false;
  }

  const existingSavedRoots = toPathArray(state["electron-saved-workspace-roots"]);
  const existingProjectOrder = toPathArray(state["project-order"]);
  const existingActiveRoots = toPathArray(state["active-workspace-roots"]);
  const nextSavedRoots = dedupePaths(
    (existingProjectOrder.length > 0
      ? [...existingProjectOrder, ...existingSavedRoots, ...existingActiveRoots]
      : [...existingSavedRoots, ...existingActiveRoots]
    ).map((value) => resolveStoredPath(value, cwdStats))
  );
  const nextProjectOrder = dedupePaths(
    (existingProjectOrder.length > 0
      ? [...existingProjectOrder, ...existingSavedRoots]
      : [...nextSavedRoots]
    ).map((value) => resolveStoredPath(value, cwdStats))
  );
  const nextActiveRoots = dedupePaths(existingActiveRoots.map((value) => resolveStoredPath(value, cwdStats)));
  const nextLabels = copyResolvedObjectKeys(state["electron-workspace-root-labels"], cwdStats);
  const openTargets = state["open-in-target-preferences"];
  const nextOpenTargets = (
    openTargets &&
    typeof openTargets === "object" &&
    !Array.isArray(openTargets)
  )
    ? {
        ...openTargets,
        perPath: copyResolvedObjectKeys((openTargets as Record<string, unknown>).perPath, cwdStats),
      }
    : openTargets;

  const originalActiveValue = state["active-workspace-roots"];
  const nextActiveValue = Array.isArray(originalActiveValue) ? nextActiveRoots : (nextActiveRoots[0] ?? originalActiveValue);
  const changed = !arraysEqual(existingSavedRoots, nextSavedRoots) ||
    !arraysEqual(existingProjectOrder, nextProjectOrder) ||
    JSON.stringify(originalActiveValue ?? null) !== JSON.stringify(nextActiveValue ?? null) ||
    JSON.stringify(state["electron-workspace-root-labels"] ?? null) !== JSON.stringify(nextLabels ?? null) ||
    JSON.stringify(state["open-in-target-preferences"] ?? null) !== JSON.stringify(nextOpenTargets ?? null) ||
    !(await pathExists(backupPath));

  if (!changed) {
    return false;
  }

  state["electron-saved-workspace-roots"] = nextSavedRoots;
  state["project-order"] = nextProjectOrder;
  state["active-workspace-roots"] = nextActiveValue;
  if (nextLabels !== undefined) {
    state["electron-workspace-root-labels"] = nextLabels;
  }
  if (nextOpenTargets !== undefined) {
    state["open-in-target-preferences"] = nextOpenTargets;
  }

  const nextText = `${JSON.stringify(state, null, 2)}\n`;
  await fs.writeFile(filePath, nextText, "utf8");
  await fs.writeFile(backupPath, nextText, "utf8");
  return true;
}

export async function syncSessions(codexHome: string, providerId?: string, options?: { fromProviderId?: string }): Promise<SyncResult> {
  const warnings: string[] = [];
  const changedFiles: string[] = [];
  const threadCwdById = new Map<string, string>();
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
    if (synced.threadId && synced.cwd) {
      threadCwdById.set(synced.threadId, synced.cwd);
    }
    if (synced.changed) {
      await fs.copyFile(file, `${file}.bak`);
      await fs.writeFile(file, synced.content, "utf8");
      changedFiles.push(file);
    }
  }

  let sqliteRowsUpdated = 0;
  let sqlitePresent = false;
  let globalStateUpdated = false;
  if (targetProviderId) {
    const sqlite = await loadSqlite(warnings);
    if (sqlite) {
      const cwdStats = await readThreadCwdStats(codexHome, sqlite, warnings);
      const sqliteResult = await updateSqliteProvider(codexHome, targetProviderId, sqlite, warnings, {
        fromProviderId: options?.fromProviderId,
        threadCwdById,
      });
      sqliteRowsUpdated = sqliteResult.rowsUpdated;
      sqlitePresent = sqliteResult.present;
      for (const [threadId, cwd] of threadCwdById) {
        const normalizedCwd = normalizeComparablePath(cwd);
        if (normalizedCwd && !cwdStats.some((stat) => stat.normalizedCwd === normalizedCwd)) {
          cwdStats.push({ cwd, normalizedCwd, count: 1, updatedAtMs: 0 });
        }
      }
      globalStateUpdated = await syncGlobalState(codexHome, cwdStats, warnings);
    } else {
      if (!(await pathExists(stateDb))) {
        warnings.push("未找到 state_5.sqlite，已跳过 SQLite 会话索引同步。");
      }
      if (!(await pathExists(globalState))) {
        warnings.push("未找到 .codex-global-state.json，已跳过项目路径缓存同步。");
      }
    }
  }

  return { changedFiles, sqliteRowsUpdated, sqlitePresent, globalStateUpdated, warnings };
}
