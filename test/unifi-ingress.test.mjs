import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import test from "node:test";

import { FileMonitorStateStore } from "../dist/monitor/state-store.js";
import { createUnifiIngressHandler, ingestUnifiEvent } from "../dist/unifi/ingress.js";
import { normalizeUnifiEvent, UnifiEventValidationError } from "../dist/unifi/normalize.js";

const cameras = [{ externalId: "synthetic-camera", protectCameraId: "protect-synthetic", roles: ["parcel"], snapshotChannel: "package" }];
const body = { camera_id: "synthetic-camera", timestamp: "2026-04-01T00:00:00.000Z", alarm: "Package", triggers: [{ type: "package" }] };

test("normalizes configured parcel cameras into a deterministic event", () => {
  const first = normalizeUnifiEvent(body, cameras);
  const second = normalizeUnifiEvent(body, cameras);
  assert.equal(first.event.eventId, second.event.eventId);
  assert.deepEqual(first.event.triggerTypes, ["package"]);
});

test("accepts the generic relay's normalized shape without changing its event ID", () => {
  const normalized = normalizeUnifiEvent(
    {
      eventId: "unifi_synthetic-id",
      externalCameraId: "synthetic-camera",
      occurredAt: "2026-04-01T00:00:00.000Z",
      alarmName: "Package",
      eventType: "package",
    },
    cameras
  );
  assert.equal(normalized.event.eventId, "unifi_synthetic-id");
  assert.deepEqual(normalized.event.triggerTypes, ["package"]);
});

test("rejects cameras outside parcel scope", () => {
  assert.throws(
    () => normalizeUnifiEvent({ ...body, camera_id: "unknown" }, cameras),
    UnifiEventValidationError
  );
});

test("persists before acceptance and deduplicates across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "parcel-unifi-test-"));
  const firstStore = new FileMonitorStateStore(directory);
  const first = await ingestUnifiEvent(firstStore, body, cameras, new Date("2026-04-01T00:00:01.000Z"));
  assert.equal(first.duplicate, false);
  const secondStore = new FileMonitorStateStore(directory);
  const duplicate = await ingestUnifiEvent(secondStore, body, cameras, new Date("2026-04-01T00:00:02.000Z"));
  assert.equal(duplicate.duplicate, true);
});

test("plugin-owned ingress rejects missing tokens before reading events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "parcel-unifi-auth-test-"));
  const handler = createUnifiIngressHandler(
    new FileMonitorStateStore(directory),
    cameras,
    async () => "synthetic-secret"
  );
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}/`;
    const unauthorized = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(unauthorized.status, 401);
    const accepted = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer synthetic-secret",
      },
      body: JSON.stringify(body),
    });
    assert.equal(accepted.status, 202);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
