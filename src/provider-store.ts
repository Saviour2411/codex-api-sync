import {
  readCodexConfig,
  removeProviderConfig,
  switchProviderConfig,
  switchToDefaultProviderConfig,
  writeProvider,
  type ConfigProvider,
} from "./codex-config.js";
import { normalizeProviderId } from "./provider-name.js";
import { syncSessions } from "./session-sync.js";
import type { Provider, ProviderInput, ProviderUpdate, SwitchResult } from "./types.js";

function toProvider(configProvider: ConfigProvider, activeProviderId: string | undefined): Provider {
  return {
    id: configProvider.id,
    name: configProvider.name,
    baseUrl: configProvider.baseUrl,
    hasApiKey: Boolean(configProvider.experimentalBearerToken),
    usesOpenAiAuth: configProvider.requiresOpenAiAuth === true,
    experimentalBearerToken: configProvider.experimentalBearerToken,
    model: undefined,
    wireApi: "responses",
    isActive: activeProviderId === configProvider.id,
  };
}

function isManagedProvider(provider: ConfigProvider): boolean {
  return provider.wireApi === "responses" && Boolean(provider.experimentalBearerToken);
}

export async function listProviders(codexHome: string): Promise<Provider[]> {
  const config = await readCodexConfig(codexHome);
  const managed = config.providers.filter(isManagedProvider);

  return managed.map((provider) => toProvider(provider, config.activeProviderId));
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

  await writeProvider(codexHome, {
    id,
    name: input.name.trim(),
    baseUrl: normalizeUrl(input.baseUrl),
    experimentalBearerToken: input.apiKey,
    wireApi: "responses",
    requiresOpenAiAuth: false,
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

  const nextBaseUrl = update.baseUrl !== undefined ? normalizeUrl(update.baseUrl) : current.baseUrl;
  const nextToken = update.apiKey !== undefined ? update.apiKey.trim() : current.experimentalBearerToken;
  if (!nextToken) {
    throw new Error("API key 不能为空。");
  }

  if (nextId !== currentId) {
    await removeProviderConfig(codexHome, currentId);
  }

  await writeProvider(codexHome, {
    id: nextId,
    name: nextName,
    baseUrl: nextBaseUrl,
    experimentalBearerToken: nextToken,
    wireApi: "responses",
    requiresOpenAiAuth: false,
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

  return { restoredDefault };
}

export async function switchProvider(codexHome: string, name: string, options?: { sync?: boolean; model?: string }): Promise<SwitchResult> {
  const id = normalizeProviderId(name);
  const provider = (await listProviders(codexHome)).find((candidate) => candidate.id === id);

  if (!provider) {
    throw new Error(`提供商 '${name}' 不存在。`);
  }

  if (!provider.hasApiKey) {
    throw new Error(`提供商 '${name}' 缺少 experimental_bearer_token。`);
  }

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

export async function switchDefaultProvider(codexHome: string, options?: { sync?: boolean; model?: string }): Promise<SwitchResult> {
  await switchToDefaultProviderConfig(codexHome, options?.model);

  const warnings: string[] = [];
  const sync = options?.sync === false ? undefined : await syncSessions(codexHome, "openai");
  if (sync) {
    warnings.push(...sync.warnings);
  }

  return {
    provider: {
      id: "openai",
      name: "openai",
      baseUrl: "https://api.openai.com/v1",
      hasApiKey: true,
      usesOpenAiAuth: true,
      wireApi: "responses",
      isActive: true,
    },
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
