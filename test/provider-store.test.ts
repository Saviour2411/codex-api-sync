import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addProvider, listProviders, removeProvider, switchProvider, updateProvider } from "../src/provider-store.js";
import { authPath, configPath } from "../src/platform.js";

async function tempCodexHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-sync-"));
  await fs.writeFile(configPath(dir), [
    'model = "gpt-5.5"',
    'sandbox_mode = "workspace-write"',
    'preferred_auth_method = "apikey"',
    "",
    '[projects."/tmp/example"]',
    'trust_level = "trusted"',
    "",
  ].join("\n"), "utf8");
  await fs.writeFile(authPath(dir), `${JSON.stringify({ OPENAI_API_KEY: "original" }, null, 2)}\n`, "utf8");
  return dir;
}

async function tempCodexHomeWithoutOpenAiKey(): Promise<string> {
  const dir = await tempCodexHome();
  await fs.writeFile(authPath(dir), `${JSON.stringify({}, null, 2)}\n`, "utf8");
  return dir;
}

test("添加提供商时写入受管配置并保留无关配置和认证字段", async () => {
  const home = await tempCodexHome();

  const provider = await addProvider(home, {
    name: "Any Router",
    baseUrl: "https://example.com/v1/",
    apiKey: "sk-any",
  });

  assert.equal(provider.id, "any-router");
  assert.equal(provider.envKey, "CODEX_PROVIDER_ANY_ROUTER_API_KEY");

  const config = await fs.readFile(configPath(home), "utf8");
  assert.match(config, /sandbox_mode = "workspace-write"/);
  assert.match(config, /\[projects\."\/tmp\/example"\]/);
  assert.match(config, /\[model_providers\.any-router\]/);
  assert.match(config, /name = "Any Router"/);
  assert.match(config, /base_url = "https:\/\/example\.com\/v1"/);
  assert.match(config, /wire_api = "responses"/);
  assert.match(config, /requires_openai_auth = true/);
  assert.doesNotMatch(config, /env_key =/);

  const auth = JSON.parse(await fs.readFile(authPath(home), "utf8")) as Record<string, unknown>;
  assert.equal(auth.OPENAI_API_KEY, "original");
  assert.equal(auth.CODEX_PROVIDER_ANY_ROUTER_API_KEY, "sk-any");
  assert.equal(auth.CODEX_API_SYNC_ORIGINAL_OPENAI_API_KEY, "original");
  assert.equal(auth.CODEX_API_SYNC_ORIGINAL_OPENAI_API_KEY_WAS_PRESENT, true);
});

test("切换提供商时激活配置并把托管 key 复制到 OPENAI_API_KEY", async () => {
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
  assert.match(config, /model = "gpt-5\.5"/);

  const auth = JSON.parse(await fs.readFile(authPath(home), "utf8")) as Record<string, unknown>;
  assert.equal(auth.OPENAI_API_KEY, "sk-any");
  assert.equal(auth.CODEX_PROVIDER_ANY_API_KEY, "sk-any");
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

test("删除最后一个自定义提供商时恢复官方默认配置", async () => {
  const home = await tempCodexHome();
  await addProvider(home, {
    name: "Any",
    baseUrl: "https://any.example/v1",
    apiKey: "sk-any",
  });
  await switchProvider(home, "Any", { sync: false });

  const result = await removeProvider(home, "Any");
  assert.equal(result.restoredDefault, true);
  assert.deepEqual(await listProviders(home), []);

  const config = await fs.readFile(configPath(home), "utf8");
  assert.doesNotMatch(config, /\[model_providers\.any\]/);
  assert.doesNotMatch(config, /model_provider =/);
  assert.doesNotMatch(config, /preferred_auth_method =/);
  assert.match(config, /\[projects\."\/tmp\/example"\]/);

  const auth = JSON.parse(await fs.readFile(authPath(home), "utf8")) as Record<string, unknown>;
  assert.equal(auth.OPENAI_API_KEY, "original");
  assert.equal(auth.CODEX_PROVIDER_ANY_API_KEY, undefined);
  assert.equal(auth.CODEX_API_SYNC_ORIGINAL_OPENAI_API_KEY, undefined);
  assert.equal(auth.CODEX_API_SYNC_ORIGINAL_OPENAI_API_KEY_WAS_PRESENT, undefined);
});

test("原来没有 OPENAI_API_KEY 时删除最后一个提供商会保留空字段", async () => {
  const home = await tempCodexHomeWithoutOpenAiKey();
  await addProvider(home, {
    name: "Any",
    baseUrl: "https://any.example/v1",
    apiKey: "sk-any",
  });
  await switchProvider(home, "Any", { sync: false });
  await removeProvider(home, "Any");

  const auth = JSON.parse(await fs.readFile(authPath(home), "utf8")) as Record<string, unknown>;
  assert.equal(auth.OPENAI_API_KEY, "");
  assert.equal(auth.CODEX_PROVIDER_ANY_API_KEY, undefined);
  assert.equal(auth.CODEX_API_SYNC_ORIGINAL_OPENAI_API_KEY, undefined);
  assert.equal(auth.CODEX_API_SYNC_ORIGINAL_OPENAI_API_KEY_WAS_PRESENT, undefined);
});

test("没有原始 key 标记时删除最后一个提供商会保留当前 OPENAI_API_KEY", async () => {
  const home = await tempCodexHome();
  await fs.writeFile(configPath(home), [
    'model_provider = "legacy"',
    '[model_providers.legacy]',
    'name = "legacy"',
    'base_url = "https://legacy.example/v1"',
    'wire_api = "responses"',
    'requires_openai_auth = true',
    "",
  ].join("\n"), "utf8");
  await fs.writeFile(authPath(home), `${JSON.stringify({
    OPENAI_API_KEY: "current",
    CODEX_PROVIDER_LEGACY_API_KEY: "managed",
  }, null, 2)}\n`, "utf8");

  await removeProvider(home, "legacy");

  const auth = JSON.parse(await fs.readFile(authPath(home), "utf8")) as Record<string, unknown>;
  assert.equal(auth.OPENAI_API_KEY, "current");
  assert.equal(auth.CODEX_PROVIDER_LEGACY_API_KEY, undefined);
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

test("提供替换 API key 时可以重命名提供商", async () => {
  const home = await tempCodexHome();
  await addProvider(home, {
    name: "Old Name",
    baseUrl: "https://old.example/v1",
    apiKey: "sk-old",
  });

  const updated = await updateProvider(home, "Old Name", {
    name: "New Name",
    baseUrl: "https://new.example/v1",
    apiKey: "sk-new",
  });

  assert.equal(updated.id, "new-name");
  const config = await fs.readFile(configPath(home), "utf8");
  assert.doesNotMatch(config, /\[model_providers\.old-name\]/);
  assert.match(config, /\[model_providers\.new-name\]/);

  const auth = JSON.parse(await fs.readFile(authPath(home), "utf8")) as Record<string, unknown>;
  assert.equal(auth.CODEX_PROVIDER_OLD_NAME_API_KEY, undefined);
  assert.equal(auth.CODEX_PROVIDER_NEW_NAME_API_KEY, "sk-new");
});
