import fs from "node:fs/promises";
import path from "node:path";

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readTextIfExists(filePath: string): Promise<string> {
  if (!(await pathExists(filePath))) {
    return "";
  }

  return fs.readFile(filePath, "utf8");
}

export async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  if (await pathExists(filePath)) {
    await fs.copyFile(filePath, `${filePath}.bak`);
  }

  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, content, "utf8");
  await fs.rename(tmpPath, filePath);
}

export async function readJsonObjectIfExists(filePath: string): Promise<Record<string, unknown>> {
  const text = await readTextIfExists(filePath);
  if (!text.trim()) {
    return {};
  }

  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }

  return value as Record<string, unknown>;
}

export async function writeJsonAtomic(filePath: string, value: Record<string, unknown>): Promise<void> {
  await writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
