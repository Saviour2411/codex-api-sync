import { configPath } from "./platform.js";
import { readTextIfExists, writeTextAtomic } from "./fs-utils.js";
import { assertValidProviderId } from "./provider-name.js";

export type ConfigProvider = {
  id: string;
  name: string;
  baseUrl: string;
  experimentalBearerToken?: string;
  wireApi?: string;
  requiresOpenAiAuth?: boolean;
};

type ProviderBlock = {
  id: string;
  startLine: number;
  endLine: number;
  values: Record<string, string>;
};

export type CodexConfig = {
  text: string;
  activeProviderId?: string;
  preferredAuthMethod?: string;
  requiresOpenAiAuth?: boolean;
  model?: string;
  providers: ConfigProvider[];
};

function splitLines(text: string): string[] {
  if (!text) {
    return [];
  }

  return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

function lineEnding(line: string): string {
  return line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
}

function parseTomlString(value: string): string | undefined {
  const trimmed = value.trim();
  const match = /^"((?:[^"\\]|\\.)*)"/.exec(trimmed);
  if (!match) {
    return undefined;
  }

  return match[1]
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t");
}

function parseTomlScalar(value: string): string | boolean | undefined {
  const stringValue = parseTomlString(value);
  if (stringValue !== undefined) {
    return stringValue;
  }

  const trimmed = value.trim();
  if (trimmed === "true") {
    return true;
  }

  if (trimmed === "false") {
    return false;
  }

  return undefined;
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
}

function parseTopLevelString(lines: string[], key: string): string | undefined {
  let inTable = false;
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*(?:#.*)?$`);

  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      inTable = true;
    }

    if (inTable) {
      continue;
    }

    const match = pattern.exec(line);
    if (match) {
      return parseTomlString(match[1]);
    }
  }

  return undefined;
}

function parseTopLevelBoolean(lines: string[], key: string): boolean | undefined {
  let inTable = false;
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*(true|false)\\s*(?:#.*)?$`);

  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      inTable = true;
    }

    if (inTable) {
      continue;
    }

    const match = pattern.exec(line);
    if (match) {
      return match[1] === "true";
    }
  }

  return undefined;
}

function providerBlocks(lines: string[]): ProviderBlock[] {
  const headers: Array<{ id: string; line: number }> = [];

  lines.forEach((line, index) => {
    const match = /^\s*\[model_providers\.([a-zA-Z0-9_-]+)\]\s*(?:#.*)?$/.exec(line);
    if (match) {
      headers.push({ id: match[1], line: index });
    }
  });

  return headers.map((header, index) => {
    const nextHeaderLine = findNextTableLine(lines, header.line + 1);
    const endLine = nextHeaderLine ?? lines.length;
    const values: Record<string, string> = {};

    for (let i = header.line + 1; i < endLine; i += 1) {
      const match = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*(?:#.*)?$/.exec(lines[i]);
      if (!match) {
        continue;
      }

      const parsed = parseTomlScalar(match[2]);
      if (parsed !== undefined) {
        values[match[1]] = String(parsed);
      }
    }

    const nextProvider = headers[index + 1]?.line;
    return {
      id: header.id,
      startLine: header.line,
      endLine: nextProvider && nextProvider < endLine ? nextProvider : endLine,
      values,
    };
  });
}

function findNextTableLine(lines: string[], start: number): number | undefined {
  for (let i = start; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) {
      return i;
    }
  }

  return undefined;
}

function setTopLevelString(text: string, key: string, value: string): string {
  const lines = splitLines(text);
  const replacement = `${key} = ${tomlString(value)}\n`;
  let firstTable = lines.length;

  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) {
      firstTable = i;
      break;
    }

    if (new RegExp(`^\\s*${key}\\s*=`).test(lines[i])) {
      const ending = lineEnding(lines[i]) || "\n";
      lines[i] = `${key} = ${tomlString(value)}${ending}`;
      return lines.join("");
    }
  }

  if (firstTable === 0) {
    lines.unshift(replacement);
  } else if (firstTable < lines.length) {
    lines.splice(firstTable, 0, replacement);
  } else {
    if (lines.length > 0 && !lines[lines.length - 1].endsWith("\n")) {
      lines[lines.length - 1] += "\n";
    }
    lines.push(replacement);
  }

  return lines.join("");
}

function setTopLevelBoolean(text: string, key: string, value: boolean): string {
  const lines = splitLines(text);
  const replacement = `${key} = ${value ? "true" : "false"}\n`;
  let firstTable = lines.length;

  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) {
      firstTable = i;
      break;
    }

    if (new RegExp(`^\\s*${key}\\s*=`).test(lines[i])) {
      const ending = lineEnding(lines[i]) || "\n";
      lines[i] = `${key} = ${value ? "true" : "false"}${ending}`;
      return lines.join("");
    }
  }

  if (firstTable === 0) {
    lines.unshift(replacement);
  } else if (firstTable < lines.length) {
    lines.splice(firstTable, 0, replacement);
  } else {
    if (lines.length > 0 && !lines[lines.length - 1].endsWith("\n")) {
      lines[lines.length - 1] += "\n";
    }
    lines.push(replacement);
  }

  return lines.join("");
}

function removeTopLevelKey(text: string, key: string): string {
  const lines = splitLines(text);
  const result: string[] = [];
  let inTable = false;

  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      inTable = true;
    }

    if (!inTable && new RegExp(`^\\s*${key}\\s*=`).test(line)) {
      continue;
    }

    result.push(line);
  }

  return result.join("");
}

function providerBlockText(provider: ConfigProvider): string {
  const lines = [
    `[model_providers.${provider.id}]`,
    `name = ${tomlString(provider.name)}`,
    `base_url = ${tomlString(provider.baseUrl)}`,
  ];

  lines.push(`wire_api = ${tomlString(provider.wireApi ?? "responses")}`);
  if (provider.experimentalBearerToken) {
    lines.push(`experimental_bearer_token = ${tomlString(provider.experimentalBearerToken)}`);
  }
  if (provider.requiresOpenAiAuth) {
    lines.push("requires_openai_auth = true");
  }
  return `${lines.join("\n")}\n`;
}

export async function readCodexConfig(codexHome: string): Promise<CodexConfig> {
  const text = await readTextIfExists(configPath(codexHome));
  const lines = splitLines(text);
  const providers = providerBlocks(lines).map((block): ConfigProvider => ({
    id: block.id,
    name: block.values.name ?? block.id,
    baseUrl: block.values.base_url ?? "",
    experimentalBearerToken: block.values.experimental_bearer_token,
    wireApi: block.values.wire_api,
    requiresOpenAiAuth: block.values.requires_openai_auth === "true",
  }));

  return {
    text,
    activeProviderId: parseTopLevelString(lines, "model_provider"),
    preferredAuthMethod: parseTopLevelString(lines, "preferred_auth_method"),
    requiresOpenAiAuth: parseTopLevelBoolean(lines, "requires_openai_auth"),
    model: parseTopLevelString(lines, "model"),
    providers,
  };
}

export async function writeProvider(codexHome: string, provider: ConfigProvider, options?: { active?: boolean; model?: string }): Promise<void> {
  assertValidProviderId(provider.id);

  const filePath = configPath(codexHome);
  let text = await readTextIfExists(filePath);
  let lines = splitLines(text);
  const existing = providerBlocks(lines).find((block) => block.id === provider.id);
  const blockText = providerBlockText(provider);

  if (existing) {
    lines.splice(existing.startLine, existing.endLine - existing.startLine, blockText);
    text = lines.join("");
  } else {
    if (text && !text.endsWith("\n")) {
      text += "\n";
    }
    text += text.trim() ? `\n${blockText}` : blockText;
  }

  if (options?.active) {
    text = setTopLevelString(text, "model_provider", provider.id);
    text = setTopLevelString(text, "preferred_auth_method", "apikey");
    text = setTopLevelBoolean(text, "requires_openai_auth", false);
  }

  if (options?.model !== undefined && options.model.trim()) {
    text = setTopLevelString(text, "model", options.model.trim());
  }

  await writeTextAtomic(filePath, text);
}

export async function switchProviderConfig(codexHome: string, providerId: string, model?: string): Promise<void> {
  assertValidProviderId(providerId);

  const filePath = configPath(codexHome);
  let text = await readTextIfExists(filePath);
  text = setTopLevelString(text, "model_provider", providerId);
  text = setTopLevelString(text, "preferred_auth_method", "apikey");
  text = setTopLevelBoolean(text, "requires_openai_auth", false);

  if (model !== undefined && model.trim()) {
    text = setTopLevelString(text, "model", model.trim());
  }

  await writeTextAtomic(filePath, text);
}

export async function switchToDefaultProviderConfig(codexHome: string, model?: string): Promise<void> {
  const filePath = configPath(codexHome);
  let text = await readTextIfExists(filePath);
  text = removeTopLevelKey(text, "model_provider");
  text = removeTopLevelKey(text, "preferred_auth_method");
  text = removeTopLevelKey(text, "requires_openai_auth");

  if (model !== undefined && model.trim()) {
    text = setTopLevelString(text, "model", model.trim());
  }

  await writeTextAtomic(filePath, text);
}

export async function removeProviderConfig(codexHome: string, providerId: string, options?: { restoreDefault?: boolean }): Promise<void> {
  assertValidProviderId(providerId);

  const filePath = configPath(codexHome);
  const text = await readTextIfExists(filePath);
  const lines = splitLines(text);
  const existing = providerBlocks(lines).find((block) => block.id === providerId);

  if (!existing) {
    return;
  }

  lines.splice(existing.startLine, existing.endLine - existing.startLine);
  let nextText = lines.join("");

  if (options?.restoreDefault) {
    nextText = removeTopLevelKey(nextText, "model_provider");
    nextText = removeTopLevelKey(nextText, "preferred_auth_method");
    nextText = removeTopLevelKey(nextText, "requires_openai_auth");
  }

  await writeTextAtomic(filePath, nextText);
}
