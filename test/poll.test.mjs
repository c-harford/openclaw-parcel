import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { monitorHealth, ParcelMonitor } from "../dist/monitor/poll.js";
import { createEmptyMonitorState } from "../dist/monitor/model.js";
import { FileMonitorStateStore } from "../dist/monitor/state-store.js";

function response(statusCode) {
  return {
    success: true,
    deliveries: [{ carrier_code: "ups", tracking_number: "SYNTHETIC-POLL", description: "Synthetic parcel", status_code: statusCode, events: [] }],
  };
}

test("poll establishes a silent baseline, rate-skips, then emits durable change", async () => {
  const directory = await mkdtemp(join(tmpdir(), "parcel-poll-test-"));
  const store = new FileMonitorStateStore(directory);
  let now = new Date("2026-03-01T00:00:00.000Z");
  let calls = 0;
  let statusCode = 2;
  const api = { async getDeliveries() { calls += 1; return response(statusCode); } };
  const monitor = new ParcelMonitor(
    api,
    store,
    { minIntervalMinutes: 10, maxRequestsPerHour: 18, missingPollThreshold: 2 },
    () => now
  );

  const baseline = await monitor.poll();
  assert.equal(baseline.outcome, "success");
  assert.equal(baseline.baselineEstablished, true);
  assert.equal(baseline.pendingNotifications.length, 0);

  const skipped = await monitor.poll();
  assert.equal(skipped.outcome, "skipped");
  assert.equal(calls, 1);

  now = new Date("2026-03-01T00:11:00.000Z");
  statusCode = 4;
  const changed = await monitor.poll();
  assert.equal(changed.outcome, "success");
  assert.equal(changed.pendingNotifications.length, 1);
  assert.equal(calls, 2);

  const restarted = new ParcelMonitor(api, store, undefined, () => now);
  assert.equal((await restarted.status()).pendingNotifications.length, 1);
});

test("pending outbox remains readable and acknowledgeable without an API client", async () => {
  const directory = await mkdtemp(join(tmpdir(), "parcel-no-api-test-"));
  const store = new FileMonitorStateStore(directory);
  const monitor = new ParcelMonitor(null, store);
  assert.equal((await monitor.poll()).errorType, "ParcelAPIConfigurationError");
  assert.deepEqual((await monitor.status()).pendingNotifications, []);
});

test("stale attempted notifications make monitor health visibly degraded", () => {
  const state = createEmptyMonitorState("2026-03-01T00:00:00.000Z");
  state.notifications.synthetic = {
    notificationId: "synthetic",
    status: "pending",
    createdAt: "2026-03-01T00:00:00.000Z",
    attemptCount: 1,
    lastAttemptAt: "2026-03-01T00:01:00.000Z",
    changeIds: [],
    payload: {},
  };
  const health = monitorHealth(state, new Date("2026-03-01T01:00:00.000Z"));
  assert.equal(health.status, "degraded");
  assert.equal(health.indicators[0].code, "notification_delivery_unacknowledged");
});
