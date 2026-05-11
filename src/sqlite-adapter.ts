export type SqliteRunResult = {
  changes: number;
};

export type SqliteConnection = {
  backend: "node:sqlite" | "node-sqlite3-wasm";
  exec: (sql: string) => void;
  all: (sql: string, values?: unknown[]) => Array<Record<string, unknown>>;
  run: (sql: string, values?: unknown[]) => SqliteRunResult;
  close: () => void;
};

type NodeSqliteDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => {
    run: (...values: unknown[]) => { changes?: number | bigint };
    all: (...values: unknown[]) => Array<Record<string, unknown>>;
  };
  close: () => void;
};

type NodeSqliteModule = {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => NodeSqliteDatabase;
};

type WasmSqliteDatabase = {
  exec: (sql: string) => void;
  all: (sql: string, values?: unknown[]) => Array<Record<string, unknown>>;
  run: (sql: string, values?: unknown[]) => { changes?: number | bigint };
  close: () => void;
};

type WasmSqliteModule = {
  Database: new (path: string, options?: { fileMustExist?: boolean; readOnly?: boolean }) => WasmSqliteDatabase;
};

function getBuiltinModule(moduleName: string): unknown {
  return (process as unknown as { getBuiltinModule?: (name: string) => unknown }).getBuiltinModule?.(moduleName);
}

async function dynamicImport(moduleName: string): Promise<unknown> {
  const importer = new Function("moduleName", "return import(moduleName)") as (name: string) => Promise<unknown>;
  return importer(moduleName);
}

function isMissingModuleError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === "ERR_UNKNOWN_BUILTIN_MODULE" || code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
}

async function loadNodeSqlite(): Promise<NodeSqliteModule | undefined> {
  const builtin = getBuiltinModule("node:sqlite");
  if (builtin && typeof builtin === "object" && "DatabaseSync" in builtin) {
    return builtin as NodeSqliteModule;
  }

  try {
    return await dynamicImport("node:sqlite") as NodeSqliteModule;
  } catch (error) {
    if (isMissingModuleError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function loadWasmSqlite(): Promise<WasmSqliteModule | undefined> {
  try {
    const imported = await dynamicImport("node-sqlite3-wasm") as WasmSqliteModule | { default?: WasmSqliteModule };
    return "Database" in imported ? imported : imported.default;
  } catch (error) {
    if (isMissingModuleError(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function openSqliteDatabase(filePath: string, options?: { readOnly?: boolean }): Promise<SqliteConnection | undefined> {
  const nodeSqlite = await loadNodeSqlite();
  if (nodeSqlite) {
    const db = new nodeSqlite.DatabaseSync(filePath, options ?? {});
    return {
      backend: "node:sqlite",
      exec: (sql) => db.exec(sql),
      all: (sql, values = []) => db.prepare(sql).all(...values),
      run: (sql, values = []) => {
        const result = db.prepare(sql).run(...values);
        return { changes: Number(result.changes ?? 0) };
      },
      close: () => db.close(),
    };
  }

  const wasmSqlite = await loadWasmSqlite();
  if (!wasmSqlite) {
    return undefined;
  }

  const db = new wasmSqlite.Database(filePath, {
    fileMustExist: options?.readOnly ?? false,
    readOnly: options?.readOnly,
  });
  return {
    backend: "node-sqlite3-wasm",
    exec: (sql) => db.exec(sql),
    all: (sql, values = []) => db.all(sql, values),
    run: (sql, values = []) => {
      const result = db.run(sql, values);
      return { changes: Number(result.changes ?? 0) };
    },
    close: () => db.close(),
  };
}
