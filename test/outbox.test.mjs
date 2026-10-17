import assert from "node:assert/strict";
import test from "node:test";

import { applyObservations } from "../dist/monitor/diff.js";
import { createEmptyMonitorState, normalizeDelivery } from "../dist/monitor/model.js";
import {
  acknowledgeNotification,
  enqueueNotifications,
  pendingNotifications,
  recordNotificationAttempt,
} from "../dist/monitor/outbox.js";

const baselineAt = "2026-02-01T00:00:00.000Z";
const changedAt = "2026-02-01T01:00:00.000Z";

function observation(statusCode, at) {
  return normalizeDelivery(
    {
      carrier_code: "fedex",
      tracking_number: "SYNTHETIC-OUTBOX",
      description: "Synthetic fixture",
      status_code: statusCode,
      events: [],
    },
    at
  );
}

test("first baseline is silent and later semantic transition is durable", () => {
  const initial = createEmptyMonitorState(baselineAt);
  const baseline = applyObservations(initial, [observation(2, baselineAt)], baselineAt);
  const silent = enqueueNotifications(baseline.state, baseline.changes, baselineAt, {
    suppress: !initial.baselineEstablished,
  });
  assert.equal(pendingNotifications(silent.state).length, 0);

  const changed = applyObservations(silent.state, [observation(4, changedAt)], changedAt);
  const queued = enqueueNotifications(changed.state, changed.changes, changedAt, { suppress: false });
  assert.equal(queued.enqueued.length, 1);
  assert.equal(pendingNotifications(queued.state).length, 1);
});

test("notification stays pending after an attempt and disappears only after ack", () => {
  const initial = createEmptyMonitorState(baselineAt);
  const baseline = applyObservations(initial, [observation(2, baselineAt)], baselineAt);
  const changed = applyObservations(baseline.state, [observation(7, changedAt)], changedAt);
  const queued = enqueueNotifications(changed.state, changed.changes, changedAt, { suppress: false });
  const id = queued.enqueued[0].notificationId;

  const attempted = recordNotificationAttempt(queued.state, id, changedAt);
  assert.equal(pendingNotifications(attempted).length, 1);
  assert.equal(attempted.notifications[id].attemptCount, 1);

  const acknowledged = acknowledgeNotification(attempted, id, changedAt);
  assert.equal(pendingNotifications(acknowledged).length, 0);
  assert.equal(acknowledged.notifications[id].status, "acknowledged");
});

test("reprocessing the same change cannot duplicate a notification", () => {
  const initial = createEmptyMonitorState(baselineAt);
  const baseline = applyObservations(initial, [observation(2, baselineAt)], baselineAt);
  const changed = applyObservations(baseline.state, [observation(0, changedAt)], changedAt);
  const first = enqueueNotifications(changed.state, changed.changes, changedAt, { suppress: false });
  const second = enqueueNotifications(first.state, changed.changes, changedAt, { suppress: false });
  assert.equal(Object.keys(second.state.notifications).length, 1);
  assert.equal(second.enqueued.length, 0);
});
