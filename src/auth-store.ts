import { authPath } from "./platform.js";
import { readJsonObjectIfExists, writeJsonAtomic } from "./fs-utils.js";

const ORIGINAL_OPENAI_KEY = "CODEX_API_SYNC_ORIGINAL_OPENAI_API_KEY";
const ORIGINAL_OPENAI_KEY_WAS_PRESENT = "CODEX_API_SYNC_ORIGINAL_OPENAI_API_KEY_WAS_PRESENT";

export async function readAuth(codexHome: string): Promise<Record<string, unknown>> {
  return readJsonObjectIfExists(authPath(codexHome));
}

export async function hasApiKey(codexHome: string, envKey: string): Promise<boolean> {
  const auth = await readAuth(codexHome);
  return typeof auth[envKey] === "string" && (auth[envKey] as string).length > 0;
}

export async function setApiKey(codexHome: string, envKey: string, apiKey: string): Promise<void> {
  const auth = await readAuth(codexHome);
  auth[envKey] = apiKey;
  await writeJsonAtomic(authPath(codexHome), auth);
}

export async function preserveOriginalOpenAiApiKey(codexHome: string): Promise<void> {
  const auth = await readAuth(codexHome);
  if (Object.prototype.hasOwnProperty.call(auth, ORIGINAL_OPENAI_KEY_WAS_PRESENT)) {
    return;
  }

  const existing = auth.OPENAI_API_KEY;
  auth[ORIGINAL_OPENAI_KEY_WAS_PRESENT] = typeof existing === "string";
  if (typeof existing === "string") {
    auth[ORIGINAL_OPENAI_KEY] = existing;
  }

  await writeJsonAtomic(authPath(codexHome), auth);
}

export async function getApiKey(codexHome: string, envKey: string): Promise<string | undefined> {
  const auth = await readAuth(codexHome);
  const value = auth[envKey];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function setOpenAiApiKeyFromManagedKey(codexHome: string, envKey: string): Promise<void> {
  const auth = await readAuth(codexHome);
  const value = auth[envKey];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`auth.json 中缺少托管 API key '${envKey}'。`);
  }

  auth.OPENAI_API_KEY = value;
  await writeJsonAtomic(authPath(codexHome), auth);
}

export async function removeApiKey(codexHome: string, envKey: string): Promise<void> {
  const auth = await readAuth(codexHome);
  if (Object.prototype.hasOwnProperty.call(auth, envKey)) {
    delete auth[envKey];
    await writeJsonAtomic(authPath(codexHome), auth);
  }
}

export async function restoreOriginalOpenAiApiKey(codexHome: string): Promise<void> {
  const auth = await readAuth(codexHome);
  if (!Object.prototype.hasOwnProperty.call(auth, ORIGINAL_OPENAI_KEY_WAS_PRESENT)) {
    return;
  }

  const wasPresent = auth[ORIGINAL_OPENAI_KEY_WAS_PRESENT] === true;
  const original = auth[ORIGINAL_OPENAI_KEY];

  if (wasPresent && typeof original === "string") {
    auth.OPENAI_API_KEY = original;
  } else {
    auth.OPENAI_API_KEY = "";
  }

  delete auth[ORIGINAL_OPENAI_KEY];
  delete auth[ORIGINAL_OPENAI_KEY_WAS_PRESENT];
  await writeJsonAtomic(authPath(codexHome), auth);
}
