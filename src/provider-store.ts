import {
  hasApiKey,
  preserveOriginalOpenAiApiKey,
  removeApiKey,
  restoreOriginalOpenAiApiKey,
  setApiKey,
  setOpenAiApiKeyFromManagedKey,
} from "./auth-store.js";
import {
  readCodexConfig,
  removeProviderConfig,
  switchProviderConfig,
  writeProvider,
  type ConfigProvider,
} from "./codex-config.js";
import { envKeyForProvider, normalizeProviderId } from "./provider-name.js";
import { syncSessions } from "./session-sync.js";
import type { Provider, ProviderInput, ProviderUpdate, SwitchResult } from "./types.js";

function toProvider(configProvider: ConfigProvider, activeProviderId: string | undefined, hasKey: boolean): Provider {
  return {
    id: configProvider.id,
    name: configProvider.name,
    baseUrl: configProvider.baseUrl,
    envKey: configProvider.envKey ?? envKeyForProvider(configProvider.id),
    hasApiKey: hasKey,
    usesOpenAiAuth: configProvider.requiresOpenAiAuth === true,
    model: undefined,
    wireApi: "responses",
    isActive: activeProviderId === configProvider.id,
  };
}

function isManagedProvider(provider: ConfigProvider): boolean {
  return provider.wireApi === "responses" && (
    Boolean(provider.envKey?.startsWith("CODEX_PROVIDER_")) ||
    provider.requiresOpenAiAuth === true
  );
}

export async function listProviders(codexHome: string): Promise<Provider[]> {
  const config = await readCodexConfig(codexHome);
  const managed = config.providers.filter(isManagedProvider);

  return Promise.all(managed.map(async (provider) => (
    toProvider(provider, config.activeProviderId, await hasApiKey(codexHome, provider.envKey ?? envKeyForProvider(provider.id)))
  )));
}

export async function getProviderByName(codexHome: string, name: string): Promise<Provider | undefined> {
  const id = normalizeProviderId(name);
  return (await listProviders(codexHome)).find((provider) => provider.id === id);
}

export async function addProvider(codexHome: string, input: ProviderInput): Promise<Provider> {
  if (!input.apiKey?.trim()) {
    throw new Error("添加提供商时必须提供 API key。");
  }

  const id = normalizeProviderId(input.name);
  const existing = await listProviders(codexHome);
  if (existing.some((provider) => provider.id === id)) {
    throw new Error(`提供商 '${input.name}' 已存在。`);
  }

  const envKey = envKeyForProvider(id);
  if (existing.length === 0) {
    await preserveOriginalOpenAiApiKey(codexHome);
  }

  await setApiKey(codexHome, envKey, input.apiKey);
  await writeProvider(codexHome, {
    id,
    name: input.name.trim(),
    baseUrl: normalizeUrl(input.baseUrl),
    wireApi: "responses",
    requiresOpenAiAuth: true,
  }, { model: input.model });

  const created = await getProviderByName(codexHome, input.name);
  if (!created) {
    throw new Error(`提供商 '${input.name}' 未创建成功。`);
  }

  return created;
}

export async function updateProvider(codexHome: string, name: string, update: ProviderUpdate): Promise<Provider> {
  const currentId = normalizeProviderId(name);
  const providers = await listProviders(codexHome);
  const current = providers.find((provider) => provider.id === currentId);

  if (!current) {
    throw new Error(`提供商 '${name}' 不存在。`);
  }

  const nextName = update.name?.trim() || current.name;
  const nextId = normalizeProviderId(nextName);

  if (nextId !== currentId && providers.some((provider) => provider.id === nextId)) {
    throw new Error(`提供商 '${nextName}' 已存在。`);
  }

  const nextEnvKey = envKeyForProvider(nextId);
  const nextBaseUrl = update.baseUrl !== undefined ? normalizeUrl(update.baseUrl) : current.baseUrl;

  if (update.apiKey !== undefined) {
    if (!update.apiKey.trim()) {
      throw new Error("API key 不能为空。");
    }
    await setApiKey(codexHome, nextEnvKey, update.apiKey);
  } else if (nextEnvKey !== current.envKey && current.hasApiKey) {
    throw new Error("重命名提供商时必须同时提供 --api-key，以便写入新的托管 key。");
  }

  if (nextEnvKey !== current.envKey) {
    await removeProviderConfig(codexHome, currentId);
    await removeApiKey(codexHome, current.envKey);
  }

  await writeProvider(codexHome, {
    id: nextId,
    name: nextName,
    baseUrl: nextBaseUrl,
    wireApi: "responses",
    requiresOpenAiAuth: true,
  }, { active: current.isActive, model: update.model });

  const updated = await getProviderByName(codexHome, nextName);
  if (!updated) {
    throw new Error(`提供商 '${nextName}' 未更新成功。`);
  }

  return updated;
}

export async function removeProvider(codexHome: string, name: string): Promise<{ restoredDefault: boolean }> {
  const id = normalizeProviderId(name);
  const providers = await listProviders(codexHome);
  const target = providers.find((provider) => provider.id === id);

  if (!target) {
    throw new Error(`提供商 '${name}' 不存在。`);
  }

  const remaining = providers.filter((provider) => provider.id !== id);
  const restoredDefault = remaining.length === 0;

  if (target.isActive && !restoredDefault) {
    throw new Error("仍有其它自定义提供商时，不能删除当前激活提供商。请先切换。");
  }

  await removeProviderConfig(codexHome, id, { restoreDefault: restoredDefault });
  await removeApiKey(codexHome, target.envKey);
  if (restoredDefault) {
    await restoreOriginalOpenAiApiKey(codexHome);
  }

  return { restoredDefault };
}

export async function switchProvider(codexHome: string, name: string, options?: { sync?: boolean; model?: string }): Promise<SwitchResult> {
  const id = normalizeProviderId(name);
  const provider = (await listProviders(codexHome)).find((candidate) => candidate.id === id);

  if (!provider) {
    throw new Error(`提供商 '${name}' 不存在。`);
  }

  if (!provider.hasApiKey) {
    throw new Error(`提供商 '${name}' 在 auth.json 中缺少 API key。`);
  }

  await setOpenAiApiKeyFromManagedKey(codexHome, provider.envKey);
  await switchProviderConfig(codexHome, id, options?.model);
  const active = await getProviderByName(codexHome, name);

  const warnings: string[] = [];
  const sync = options?.sync === false ? undefined : await syncSessions(codexHome, id);
  if (sync) {
    warnings.push(...sync.warnings);
  }

  return {
    provider: active ?? { ...provider, isActive: true },
    sync,
    warnings,
  };
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Base URL 必须使用 http 或 https。");
  }

  return trimmed.replace(/\/+$/, "");
}
