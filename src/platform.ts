import os from "node:os";
import path from "node:path";

export function getCodexHome(explicitHome?: string): string {
  if (explicitHome && explicitHome.trim()) {
    return path.resolve(explicitHome);
  }

  if (process.env.CODEX_HOME && process.env.CODEX_HOME.trim()) {
    return path.resolve(process.env.CODEX_HOME);
  }

  return path.join(os.homedir(), ".codex");
}

export function configPath(codexHome: string): string {
  return path.join(codexHome, "config.toml");
}

export function authPath(codexHome: string): string {
  return path.join(codexHome, "auth.json");
}
