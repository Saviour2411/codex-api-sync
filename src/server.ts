import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addProvider,
  listProviders,
  removeProvider,
  switchDefaultProvider,
  switchProvider,
  updateProvider,
} from "./provider-store.js";
import { syncSessions } from "./session-sync.js";

export type ServerOptions = {
  host: string;
  port: number;
  codexHome: string;
};

export type StartedServer = {
  host: string;
  port: number;
  close: () => Promise<void>;
};

const dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(dirname, "../public");

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const text = Buffer.concat(chunks).toString("utf8");
  return text.trim() ? JSON.parse(text) : {};
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function methodNotAllowed(res: http.ServerResponse): void {
  sendJson(res, 405, { error: "不支持该请求方法。" });
}

function providerNameFromPath(pathname: string, suffix = ""): string | undefined {
  const prefix = "/api/providers/";
  if (!pathname.startsWith(prefix)) {
    return undefined;
  }

  let value = pathname.slice(prefix.length);
  if (suffix) {
    if (!value.endsWith(suffix)) {
      return undefined;
    }
    value = value.slice(0, -suffix.length);
  }

  return decodeURIComponent(value);
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
  const filePath = pathname === "/" ? path.join(publicDir, "index.html") : path.join(publicDir, pathname);
  const resolved = path.resolve(filePath);

  if (!resolved.startsWith(publicDir)) {
    sendJson(res, 403, { error: "禁止访问。" });
    return;
  }

  try {
    const content = await fs.readFile(resolved);
    const ext = path.extname(resolved);
    const type = ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : "text/html";
    res.writeHead(200, { "content-type": `${type}; charset=utf-8` });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "未找到。" });
  }
}

export async function startServer(options: ServerOptions): Promise<StartedServer> {
  const server = http.createServer((req, res) => {
    void handleRequest(options.codexHome, req, res).catch((error: unknown) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;

  return {
    host: options.host,
    port,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function handleRequest(codexHome: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  if (pathname === "/api/status" && req.method === "GET") {
    sendJson(res, 200, { codexHome });
    return;
  }

  if (pathname === "/api/providers") {
    if (req.method === "GET") {
      sendJson(res, 200, { providers: await listProviders(codexHome) });
      return;
    }

    if (req.method === "POST") {
      sendJson(res, 201, { provider: await addProvider(codexHome, await readBody(req) as never) });
      return;
    }

    methodNotAllowed(res);
    return;
  }

  if (pathname === "/api/providers/default/switch") {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return;
    }

    const body = await readBody(req) as { noSync?: boolean; model?: string };
    sendJson(res, 200, await switchDefaultProvider(codexHome, { sync: body.noSync !== true, model: body.model }));
    return;
  }

  const switchName = providerNameFromPath(pathname, "/switch");
  if (switchName !== undefined) {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return;
    }

    const body = await readBody(req) as { noSync?: boolean; model?: string };
    sendJson(res, 200, await switchProvider(codexHome, switchName, { sync: body.noSync !== true, model: body.model }));
    return;
  }

  const providerName = providerNameFromPath(pathname);
  if (providerName !== undefined) {
    if (req.method === "PATCH") {
      sendJson(res, 200, { provider: await updateProvider(codexHome, providerName, await readBody(req) as never) });
      return;
    }

    if (req.method === "DELETE") {
      const body = await readBody(req) as { noSync?: boolean };
      sendJson(res, 200, await removeProvider(codexHome, providerName, { sync: body.noSync !== true }));
      return;
    }

    methodNotAllowed(res);
    return;
  }

  if (pathname === "/api/sync") {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return;
    }

    sendJson(res, 200, await syncSessions(codexHome));
    return;
  }

  if (pathname.startsWith("/api/")) {
    sendJson(res, 404, { error: "未找到。" });
    return;
  }

  await serveStatic(req, res, pathname);
}
