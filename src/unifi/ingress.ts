import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

import { stableId } from "../monitor/model.js";
import { FileMonitorStateStore } from "../monitor/state-store.js";
import { normalizeUnifiEvent, UnifiEventValidationError } from "./normalize.js";
import type { NormalizedUnifiEvent, ParcelCameraConfig } from "./types.js";

const MAX_BODY_BYTES = 256 * 1024;

export interface UnifiIngestResult {
  accepted: boolean;
  duplicate: boolean;
  event: NormalizedUnifiEvent;
}

export async function ingestUnifiEvent(
  store: FileMonitorStateStore,
  body: unknown,
  cameras: ParcelCameraConfig[],
  now = new Date()
): Promise<UnifiIngestResult> {
  const normalized = normalizeUnifiEvent(body, cameras);
  return store.withLock(async () => {
    let state = await store.load();
    const existing = state.unifiEvents[normalized.event.eventId];
    if (existing) return { accepted: true, duplicate: true, event: normalized.event };
    const receivedAt = now.toISOString();
    state.unifiEvents[normalized.event.eventId] = {
      eventId: normalized.event.eventId,
      receivedAt,
      updatedAt: receivedAt,
      stage: "received",
      expiresAt: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
      data: {
        normalized: normalized.event,
        camera: {
          externalId: normalized.camera.externalId,
          protectCameraId: normalized.camera.protectCameraId,
          roles: normalized.camera.roles,
          snapshotChannel: normalized.camera.snapshotChannel,
        },
      },
    };
    state.updatedAt = receivedAt;
    state = await store.save(state);
    return { accepted: true, duplicate: false, event: normalized.event };
  });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new UnifiEventValidationError("UniFi event exceeds 256 KiB");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new UnifiEventValidationError("UniFi event body is not valid JSON");
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

export function createUnifiIngressHandler(
  store: FileMonitorStateStore,
  cameras: ParcelCameraConfig[],
  resolveIngressToken: () => Promise<string | undefined>,
  onAccepted?: () => Promise<unknown>
): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  return async (request, response) => {
    if (request.method !== "POST") {
      sendJson(response, 405, { success: false, error: "Method not allowed" });
      return true;
    }
    try {
      const expectedToken = await resolveIngressToken();
      const suppliedToken = request.headers.authorization?.replace(/^Bearer\s+/i, "") ??
        (typeof request.headers["x-plugin-token"] === "string"
          ? request.headers["x-plugin-token"]
          : undefined);
      if (!expectedToken) {
        sendJson(response, 503, { success: false, error: "UniFi ingress token is not configured" });
        return true;
      }
      const expected = Buffer.from(expectedToken);
      const supplied = Buffer.from(suppliedToken ?? "");
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
        sendJson(response, 401, { success: false, error: "Unauthorized" });
        return true;
      }
      const result = await ingestUnifiEvent(store, await readJsonBody(request), cameras);
      sendJson(response, result.duplicate ? 200 : 202, {
        success: true,
        accepted: result.accepted,
        duplicate: result.duplicate,
        eventId: result.event.eventId,
      });
      if (!result.duplicate && onAccepted) {
        void onAccepted().catch(() => {
          // The event is already durable. parcel_camera_process or the next
          // heartbeat can resume it after an asynchronous processing failure.
        });
      }
    } catch (error) {
      const validation = error instanceof UnifiEventValidationError;
      sendJson(response, validation ? 400 : 500, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        errorId: stableId("ingress-error", {
          kind: error instanceof Error ? error.name : "UnknownError",
          at: new Date().toISOString(),
        }),
      });
    }
    return true;
  };
}
