import assert from "node:assert/strict";
import test from "node:test";

import {
  computeRetryDelay,
  normalizeRelayEvent,
  resolveEnvironment,
  resolveSecretReferences,
  routeMatches,
} from "../relay/relay.mjs";

test("relay creates deterministic event IDs and routes by concern", () => {
  const raw = { alarm: { name: "Delivery", triggers: [{ key: "package", device: "SYNTHETIC", timestamp: 1770000000000 }] } };
  const first = normalizeRelayEvent(raw);
  const second = normalizeRelayEvent(raw);
  assert.equal(first.eventId, second.eventId);
  assert.equal(routeMatches({ match: { eventType: ["package"] } }, first), true);
  assert.equal(routeMatches({ match: { eventType: ["person"] } }, first), false);
});

test("relay normalization is idempotent for already-normalized events", () => {
  const event = normalizeRelayEvent({
    eventId: "unifi_fixture",
    externalCameraId: "synthetic",
    eventType: "package",
    alarmName: "Delivery",
    occurredAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(event.eventId, "unifi_fixture");
  assert.equal(event.externalCameraId, "synthetic");
});

test("relay retry delay is bounded", () => {
  assert.equal(computeRetryDelay(0), 1000);
  assert.equal(computeRetryDelay(30), 15 * 60_000);
});

test("relay config resolves secrets from the environment", () => {
  assert.deepEqual(resolveEnvironment({ token: "${SYNTHETIC_TOKEN}" }, { SYNTHETIC_TOKEN: "fixture" }), { token: "fixture" });
  assert.throws(() => resolveEnvironment("${MISSING_TOKEN}", {}));
});

test("relay config resolves SecretRefs from one JSON document", () => {
  const reference = { source: "file", provider: "secrets", id: "/unifi/relayToken" };
  assert.deepEqual(
    resolveSecretReferences({ header: reference }, { unifi: { relayToken: "fixture" } }),
    { header: "fixture" }
  );
  assert.throws(() => resolveSecretReferences(reference, {}));
});
