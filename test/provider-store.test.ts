import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addProvider, doctor, listProviders, removeProvider, switchDefaultProvider, switchProvider, updateProvider } from "../src/provider-store.js";
import { authPath, configPath } from "../src/platform.js";
import { openSqliteDatabase } from "../src/sqlite-adapter.js";

async function tempCodexHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-sync-"));
  await fs.writeFile(configPath(dir), [
    'model = "gpt-5.5"',
    'sandbox_mode = "workspace-write"',
    "",
    '[projects."/tmp/example"]',
    'trust_level = "trusted"',
    "",
  ].join("\n"), "utf8");
  await fs.writeFile(authPath(dir), `${JSON.stringify({ OPENAI_API_KEY: "original" }, null, 2)}\n`, "utf8");
  return dir;
}

test("添加提供商时写入 bearer token 配置并保留 auth.json", async () => {
  const home = await tempCodexHome();

  const provider = await addProvider(home, {
    name: "Any Router",
    baseUrl: "https://example.com/v1/",
    apiKey: "sk-any",
  });

  assert.equal(provider.id, "any-router");
  assert.equal(provider.hasApiKey, true);

  const config = await fs.readFile(configPath(home), "utf8");
  assert.match(config, /sandbox_mode = "workspace-write"/);
  assert.match(config, /\[projects\."\/tmp\/example"\]/);
  assert.match(config, /\[model_providers\.any-router\]/);
  assert.match(config, /name = "Any Router"/);
  assert.match(config, /base_url = "https:\/\/example\.com\/v1"/);
  assert.match(config, /wire_api = "responses"/);
  assert.match(config, /experimental_bearer_token = "sk-any"/);
  assert.match(config, /requires_openai_auth = false/);
  assert.doesNotMatch(config, /requires_openai_auth = true/);
  assert.doesNotMatch(config, /env_key =/);

  const auth = JSON.parse(await fs.readFile(authPath(home), "utf8")) as Record<string, unknown>;
  assert.deepEqual(auth, { OPENAI_API_KEY: "original" });
});

test("切换提供商时只改全局 provider 字段，不改 auth.json", async () => {
  const home = await tempCodexHome();
  await addProvider(home, {
    name: "Any",
    baseUrl: "https://any.example/v1",
    apiKey: "sk-any",
  });

  const result = await switchProvider(home, "Any", { sync: false, model: "gpt-5.5" });
  assert.equal(result.provider.isActive, true);

  const config = await fs.readFile(configPath(home), "utf8");
  assert.match(config, /model_provider = "any"/);
  assert.match(config, /preferred_auth_method = "apikey"/);
  assert.match(config, /requires_openai_auth = false/);
  assert.match(config, /model = "gpt-5\.5"/);

  const auth = JSON.parse(await fs.readFile(authPath(home), "utf8")) as Record<string, unknown>;
  assert.deepEqual(auth, { OPENAI_API_KEY: "original" });
});

test("doctor 可以发现当前第三方 provider 配置是否生效", async () => {
  const home = await tempCodexHome();
  await addProvider(home, {
    name: "Any",
    baseUrl: "https://any.example/v1",
    apiKey: "sk-any",
  });
  await switchProvider(home, "Any", { sync: false });

  const result = await doctor(home);
  assert.equal(result.activeProviderId, "any");
  assert.equal(result.activeProvider?.baseUrl, "https://any.example/v1");
  assert.deepEqual(result.problems, []);
});

test("doctor 可以发现当前 model_provider 缺少 provider 配置", async () => {
  const home = await tempCodexHome();
  await fs.writeFile(configPath(home), [
    'model_provider = "tmp"',
    'preferred_auth_method = "apikey"',
    'requires_openai_auth = false',
    "",
  ].join("\n"), "utf8");

  const result = await doctor(home);
  assert.equal(result.activeProviderId, "tmp");
  assert.match(result.problems.join("\n"), /没有对应的受管 provider 配置/);
});

test("写入顶层字段时不会生成重复 model 或 model_providermodel 脏字段", async () => {
  const home = await tempCodexHome();
  await fs.writeFile(configPath(home), [
    'model = "old"',
    'model = "duplicate"',
    'model_providermodel = "dirty"',
    '[projects."/tmp/example"]',
    'trust_level = "trusted"',
    "",
  ].join("\n"), "utf8");

  await addProvider(home, {
    name: "Any",
    baseUrl: "https://any.example/v1",
    apiKey: "sk-any",
  });
  await switchProvider(home, "Any", { sync: false, model: "gpt-5.5" });

  const config = await fs.readFile(configPath(home), "utf8");
  assert.equal((config.match(/^model = /gm) ?? []).length, 1);
  assert.equal((config.match(/^model_provider = /gm) ?? []).length, 1);
  assert.doesNotMatch(config, /model_providermodel/);
  assert.match(config, /^model = "gpt-5\.5"$/m);
  assert.match(config, /^model_provider = "any"$/m);
});

test("文件末尾无换行时插入顶层字段不会和 model 粘连", async () => {
  const home = await tempCodexHome();
  await fs.writeFile(configPath(home), 'model = "old"', "utf8");

  await addProvider(home, {
    name: "Any",
    baseUrl: "https://any.example/v1",
    apiKey: "sk-any",
  });
  await switchProvider(home, "Any", { sync: false });

  const config = await fs.readFile(configPath(home), "utf8");
  assert.doesNotMatch(config, /model_providermodel/);
  assert.match(config, /^model = "old"$/m);
  assert.match(config, /^model_provider = "any"$/m);
});

test("切换提供商默认同步 session_meta model_provider", async () => {
  const home = await tempCodexHome();
  const sessionDir = path.join(home, "sessions", "2026", "05", "10");
  const sessionFile = path.join(sessionDir, "rollout.jsonl");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(sessionFile, [
    JSON.stringify({ timestamp: "now", type: "session_meta", payload: { id: "thread", model_provider: "old" } }),
    JSON.stringify({ timestamp: "now", type: "event_msg", payload: { type: "noop" } }),
    "",
  ].join("\n"), "utf8");

  await addProvider(home, {
    name: "Any",
    baseUrl: "https://any.example/v1",
    apiKey: "sk-any",
  });

  const result = await switchProvider(home, "Any");
  assert.equal(result.sync?.changedFiles.length, 1);

  const synced = await fs.readFile(sessionFile, "utf8");
  assert.match(synced, /"model_provider":"any"/);
  await fs.access(`${sessionFile}.bak`);
});

test("同步会话时只改 rollout 第一行 session_meta", async () => {
  const home = await tempCodexHome();
  const sessionDir = path.join(home, "sessions", "2026", "05", "10");
  const sessionFile = path.join(sessionDir, "rollout.jsonl");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(sessionFile, [
    JSON.stringify({ timestamp: "now", type: "session_meta", payload: { id: "thread", model_provider: "old" } }),
    JSON.stringify({ timestamp: "later", type: "event_msg", payload: { model_provider: "old" } }),
    "",
  ].join("\n"), "utf8");

  await addProvider(home, {
    name: "Any",
    baseUrl: "https://any.example/v1",
    apiKey: "sk-any",
  });

  await switchProvider(home, "Any");
  const lines = (await fs.readFile(sessionFile, "utf8")).trim().split("\n");
  assert.match(lines[0], /"model_provider":"any"/);
  assert.match(lines[1], /"model_provider":"old"/);
});

test("Node 20 可通过 WASM fallback 同步 state_5.sqlite", async () => {
  const home = await tempCodexHome();
  const dbPath = path.join(home, "state_5.sqlite");
  const db = await openSqliteDatabase(dbPath);
  assert.ok(db);
  if (Number(process.versions.node.split(".")[0]) < 22) {
    assert.equal(db.backend, "node-sqlite3-wasm");
  }
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT, cwd TEXT)");
  db.run("INSERT INTO threads (id, model_provider, cwd) VALUES (?, ?, ?)", ["thread", "old", "/tmp/example"]);
  db.close();

  await addProvider(home, {
    name: "Any",
    baseUrl: "https://any.example/v1",
    apiKey: "sk-any",
  });

  const result = await switchProvider(home, "Any");
  assert.equal(result.sync?.sqlitePresent, true);
  assert.equal(result.sync?.sqliteRowsUpdated, 1);

  const verifyDb = await openSqliteDatabase(dbPath, { readOnly: true });
  assert.ok(verifyDb);
  const rows = verifyDb.all("SELECT model_provider FROM threads WHERE id = ?", ["thread"]);
  verifyDb.close();
  assert.deepEqual(rows, [{ model_provider: "any" }]);
});

test("删除最后一个自定义提供商时恢复官方默认配置路径", async () => {
  const home = await tempCodexHome();
  const sessionDir = path.join(home, "sessions", "2026", "05", "12");
  const sessionFile = path.join(sessionDir, "rollout.jsonl");
  const oldProviderFile = path.join(sessionDir, "old-provider.jsonl");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(sessionFile, [
    JSON.stringify({ timestamp: "now", type: "session_meta", payload: { id: "thread", model_provider: "any" } }),
    "",
  ].join("\n"), "utf8");
  await fs.writeFile(oldProviderFile, [
    JSON.stringify({ timestamp: "now", type: "session_meta", payload: { id: "old-thread", model_provider: "old-provider" } }),
    "",
  ].join("\n"), "utf8");

  await addProvider(home, {
    name: "Any",
    baseUrl: "https://any.example/v1",
    apiKey: "sk-any",
  });
  await switchProvider(home, "Any", { sync: false });

  const result = await removeProvider(home, "Any");
  assert.equal(result.restoredDefault, true);
  assert.equal(result.sync?.changedFiles.length, 2);
  assert.deepEqual(await listProviders(home), []);

  const config = await fs.readFile(configPath(home), "utf8");
  assert.doesNotMatch(config, /\[model_providers\.any\]/);
  assert.doesNotMatch(config, /model_provider =/);
  assert.doesNotMatch(config, /preferred_auth_method =/);
  assert.doesNotMatch(config, /requires_openai_auth =/);
  assert.match(config, /\[projects\."\/tmp\/example"\]/);

  const auth = JSON.parse(await fs.readFile(authPath(home), "utf8")) as Record<string, unknown>;
  assert.deepEqual(auth, { OPENAI_API_KEY: "original" });

  const synced = await fs.readFile(sessionFile, "utf8");
  assert.match(synced, /"model_provider":"openai"/);
  assert.match(await fs.readFile(oldProviderFile, "utf8"), /"model_provider":"openai"/);
});

test("删除非最后一个提供商时也会清理该 provider 的历史引用", async () => {
  const home = await tempCodexHome();
  const sessionDir = path.join(home, "sessions", "2026", "05", "13");
  const tmpFile = path.join(sessionDir, "tmp.jsonl");
  const otherFile = path.join(sessionDir, "other.jsonl");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(tmpFile, `${JSON.stringify({ timestamp: "now", type: "session_meta", payload: { id: "tmp", model_provider: "tmp" } })}\n`, "utf8");
  await fs.writeFile(otherFile, `${JSON.stringify({ timestamp: "now", type: "session_meta", payload: { id: "other", model_provider: "other" } })}\n`, "utf8");

  await addProvider(home, {
    name: "tmp",
    baseUrl: "https://tmp.example/v1",
    apiKey: "sk-tmp",
  });
  await addProvider(home, {
    name: "other",
    baseUrl: "https://other.example/v1",
    apiKey: "sk-other",
  });
  await switchProvider(home, "other", { sync: false });

  const result = await removeProvider(home, "tmp");
  assert.equal(result.restoredDefault, false);
  assert.equal(result.sync?.changedFiles.length, 1);

  assert.match(await fs.readFile(tmpFile, "utf8"), /"model_provider":"openai"/);
  assert.match(await fs.readFile(otherFile, "utf8"), /"model_provider":"other"/);
});

test("可以在保留自定义提供商时手动切换到默认 OpenAI", async () => {
  const home = await tempCodexHome();
  const sessionDir = path.join(home, "sessions", "2026", "05", "11");
  const sessionFile = path.join(sessionDir, "rollout.jsonl");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(sessionFile, [
    JSON.stringify({ timestamp: "now", type: "session_meta", payload: { id: "thread", model_provider: "any" } }),
    "",
  ].join("\n"), "utf8");

  await addProvider(home, {
    name: "Any",
    baseUrl: "https://any.example/v1",
    apiKey: "sk-any",
  });
  await switchProvider(home, "Any", { sync: false });

  const result = await switchDefaultProvider(home);
  assert.equal(result.provider.id, "openai");
  assert.equal(result.sync?.changedFiles.length, 1);
  assert.equal((await listProviders(home)).length, 1);

  const config = await fs.readFile(configPath(home), "utf8");
  const topLevelConfig = config.slice(0, config.indexOf("[projects."));
  assert.match(config, /\[model_providers\.any\]/);
  assert.doesNotMatch(topLevelConfig, /model_provider =/);
  assert.doesNotMatch(topLevelConfig, /preferred_auth_method =/);
  assert.doesNotMatch(topLevelConfig, /requires_openai_auth =/);

  const synced = await fs.readFile(sessionFile, "utf8");
  assert.match(synced, /"model_provider":"openai"/);
});

test("仍有其它自定义提供商时禁止删除当前激活提供商", async () => {
  const home = await tempCodexHome();
  await addProvider(home, {
    name: "One",
    baseUrl: "https://one.example/v1",
    apiKey: "sk-one",
  });
  await addProvider(home, {
    name: "Two",
    baseUrl: "https://two.example/v1",
    apiKey: "sk-two",
  });
  await switchProvider(home, "One", { sync: false });

  await assert.rejects(removeProvider(home, "One"), /不能删除当前激活提供商/);
});

test("不提供新 API key 时更新提供商会保留原 token", async () => {
  const home = await tempCodexHome();
  await addProvider(home, {
    name: "Old Name",
    baseUrl: "https://old.example/v1",
    apiKey: "sk-old",
  });

  const updated = await updateProvider(home, "Old Name", {
    name: "New Name",
    baseUrl: "https://new.example/v1",
  });

  assert.equal(updated.id, "new-name");
  const config = await fs.readFile(configPath(home), "utf8");
  assert.doesNotMatch(config, /\[model_providers\.old-name\]/);
  assert.match(config, /\[model_providers\.new-name\]/);
  assert.match(config, /experimental_bearer_token = "sk-old"/);
});
