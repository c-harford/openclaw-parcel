#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

function stableId(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function normalizeRelayEvent(body) {
  const trigger = body?.alarm?.triggers?.[0] ?? body?.trigger ?? {};
  const alarmName = String(body?.alarm?.name ?? body?.alarmName ?? "");
  const eventType = String(trigger?.key ?? trigger?.type ?? body?.eventType ?? "").toLowerCase();
  const externalCameraId = String(
    trigger?.device ?? body?.externalCameraId ?? body?.camera_id ?? body?.cameraId ?? ""
  ).toLowerCase();
  const rawTimestamp = trigger?.timestamp ?? body?.timestamp ?? body?.occurredAt ?? Date.now();
  const occurredAt = new Date(rawTimestamp).toISOString();
  const suppliedId = body?.event_id ?? body?.eventId ?? body?.id;
  const eventId = suppliedId
    ? (String(suppliedId).startsWith("unifi_") ? String(suppliedId) : `unifi_${String(suppliedId)}`)
    : `unifi_${stableId({ alarmName, eventType, externalCameraId, occurredAt })}`;
  return { eventId, alarmName, eventType, externalCameraId, occurredAt, raw: body };
}

export function routeMatches(route, event) {
  const match = route.match ?? {};
  if (match.eventType && ![].concat(match.eventType).map(String).includes(event.eventType)) return false;
  if (match.notEventType && [].concat(match.notEventType).map(String).includes(event.eventType)) return false;
  if (match.alarmName && ![].concat(match.alarmName).map(String).includes(event.alarmName)) return false;
  if (match.externalCameraId && ![].concat(match.externalCameraId).map(String).includes(event.externalCameraId)) return false;
  return true;
}

export function computeRetryDelay(attempt, maximumMs = 15 * 60_000) {
  return Math.min(maximumMs, 1_000 * 2 ** Math.min(Math.max(attempt, 0), 10));
}

export function resolveEnvironment(value, environment = process.env) {
  if (Array.isArray(value)) return value.map((item) => resolveEnvironment(item, environment));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, resolveEnvironment(child, environment)])
    );
  }
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_match, name) => {
    const resolved = environment[name];
    if (!resolved) throw new Error(`Required environment variable ${name} is not set`);
    return resolved;
  });
}

function jsonPointer(document, pointer) {
  if (!pointer) return document;
  return pointer
    .replace(/^\//, "")
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((current, part) => current?.[part], document);
}

export function resolveSecretReferences(value, secretDocument) {
  if (Array.isArray(value)) {
    return value.map((item) => resolveSecretReferences(item, secretDocument));
  }
  if (value && typeof value === "object") {
    if (
      value.source === "file" &&
      value.provider === "secrets" &&
      typeof value.id === "string"
    ) {
      const resolved = jsonPointer(secretDocument, value.id);
      if (typeof resolved !== "string" || !resolved) {
        throw new Error(`Required secret ${value.id} is missing`);
      }
      return resolved;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        resolveSecretReferences(child, secretDocument),
      ])
    );
  }
  return value;
}

export async function loadRelayConfig(configPath) {
  const parsed = JSON.parse(await readFile(configPath, "utf8"));
  const secretDocument = parsed.secretsFile
    ? JSON.parse(await readFile(parsed.secretsFile, "utf8"))
    : {};
  return resolveEnvironment(resolveSecretReferences(parsed, secretDocument));
}

async function atomicWrite(path, value) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

async function readBody(request, maximumBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBytes) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function respond(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function deliver(item, config) {
  const route = config.routes.find((candidate) => candidate.name === item.route);
  if (!route) throw new Error(`Unknown route ${item.route}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), route.timeoutMs ?? 15_000);
  try {
    const response = await fetch(route.target.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(route.target.headers ?? {}) },
      body: JSON.stringify(item.event),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`target returned HTTP ${response.status}`);
  } finally {
    clearTimeout(timer);
  }
}

async function processSpool(config) {
  const names = (await readdir(config.spoolDirectory)).filter((name) => name.endsWith(".json")).sort();
  const now = Date.now();
  for (const name of names) {
    const path = join(config.spoolDirectory, name);
    let item;
    try {
      item = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      console.error(`spool read failed for ${name}:`, error);
      continue;
    }
    if (Date.parse(item.nextAttemptAt) > now) continue;
    try {
      await deliver(item, config);
      await unlink(path);
    } catch (error) {
      item.attempts += 1;
      item.lastError = error instanceof Error ? error.message : String(error);
      item.nextAttemptAt = new Date(now + computeRetryDelay(item.attempts)).toISOString();
      await atomicWrite(path, item);
    }
  }
}

export async function startRelay(config) {
  await mkdir(config.spoolDirectory, { recursive: true, mode: 0o700 });
  let processing = false;
  const drain = async () => {
    if (processing) return;
    processing = true;
    try { await processSpool(config); } finally { processing = false; }
  };
  const timer = setInterval(() => void drain(), config.workerIntervalMs ?? 5_000);
  timer.unref();

  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      const queued = (await readdir(config.spoolDirectory)).filter((name) => name.endsWith(".json")).length;
      respond(response, 200, { healthy: true, queued });
      return;
    }
    if (request.method !== "POST" || request.url !== "/events") {
      respond(response, 404, { success: false, error: "not_found" });
      return;
    }
    if (config.listen.sharedSecret && request.headers["x-relay-token"] !== config.listen.sharedSecret) {
      respond(response, 401, { success: false, error: "unauthorized" });
      return;
    }
    const remoteAddress = request.socket.remoteAddress?.replace(/^::ffff:/, "");
    if (config.listen.allowSources?.length && !config.listen.allowSources.includes(remoteAddress)) {
      respond(response, 403, { success: false, error: "source_not_allowed" });
      return;
    }
    try {
      const event = normalizeRelayEvent(await readBody(request, config.listen.maxBodyBytes ?? 256 * 1024));
      const routes = config.routes.filter((route) => routeMatches(route, event));
      if (!routes.length) {
        respond(response, 202, { success: true, accepted: false, reason: "no_route", eventId: event.eventId });
        return;
      }
      const queuedCount = (await readdir(config.spoolDirectory)).filter((name) => name.endsWith(".json")).length;
      if (queuedCount + routes.length > (config.maxSpoolItems ?? 10_000)) {
        respond(response, 503, { success: false, error: "spool_capacity_exceeded" });
        return;
      }
      for (const route of routes) {
        const path = join(config.spoolDirectory, `${event.eventId}-${stableId(route.name).slice(0, 12)}.json`);
        try {
          await stat(path);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
          await atomicWrite(path, {
            schemaVersion: 1,
            route: route.name,
            event,
            attempts: 0,
            acceptedAt: new Date().toISOString(),
            nextAttemptAt: new Date().toISOString(),
          });
        }
      }
      respond(response, 202, { success: true, accepted: true, eventId: event.eventId, routes: routes.map((route) => route.name) });
      void drain();
    } catch (error) {
      respond(response, error?.message === "request_too_large" ? 413 : 400, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  await new Promise((resolveListen) => server.listen(config.listen.port, config.listen.host, resolveListen));
  return server;
}

async function main() {
  const configPath = resolve(process.env.PARCEL_RELAY_CONFIG ?? process.argv[2] ?? "./relay.config.json");
  const config = await loadRelayConfig(configPath);
  await startRelay(config);
  console.log(`parcel relay listening on ${config.listen.host}:${config.listen.port}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
