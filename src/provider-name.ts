const RESERVED_PROVIDER_IDS = new Set(["openai", "ollama", "lmstudio"]);

export function normalizeProviderId(name: string): string {
  const id = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");

  if (!id) {
    throw new Error("提供商名称必须至少包含一个字母或数字。");
  }

  if (RESERVED_PROVIDER_IDS.has(id)) {
    throw new Error(`提供商名称 '${name}' 与 Codex 保留提供商 '${id}' 冲突。`);
  }

  return id;
}

export function envKeyForProvider(id: string): string {
  const suffix = id.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `CODEX_PROVIDER_${suffix}_API_KEY`;
}

export function assertValidProviderId(id: string): void {
  if (!/^[a-z0-9_-]+$/.test(id)) {
    throw new Error(`无效的提供商 id：'${id}'。`);
  }

  if (RESERVED_PROVIDER_IDS.has(id)) {
    throw new Error(`提供商 id '${id}' 是 Codex 保留值。`);
  }
}
