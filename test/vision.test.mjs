import assert from "node:assert/strict";
import test from "node:test";

import { createEmptyMonitorState, normalizeDelivery } from "../dist/monitor/model.js";
import { applyObservations } from "../dist/monitor/diff.js";
import { correlateParcelEvent } from "../dist/vision/correlation.js";
import { OpenClawVisionProvider } from "../dist/vision/openclaw-provider.js";

const models = [
  { provider: "missing-provider", model: "synthetic-a" },
  { provider: "fallback-provider", model: "synthetic-b" },
];
const snapshot = { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg" };
const context = { eventId: "synthetic-event", cameraRole: ["parcel"], occurredAt: "2026-05-01T12:00:00.000Z" };

test("missing MediaUnderstandingProvider falls through to the next configured model", async () => {
  const provider = new OpenClawVisionProvider(
    async ({ provider, model }) => {
      if (provider === "missing-provider") throw new Error("No MediaUnderstandingProvider registered for missing-provider");
      return {
        parsed: { packagePresent: "yes", confidence: 0.91, observations: ["parcel-shaped object"] },
        text: "",
        provider,
        model,
      };
    },
    {},
    models
  );
  const result = await provider.inspectPackage(snapshot, context);
  assert.equal(result.availability, "available");
  assert.equal(result.provider, "fallback-provider");
  assert.equal(result.attempts.length, 1);
});

test("all missing provider registrations produce explicit unavailable result", async () => {
  const provider = new OpenClawVisionProvider(
    async () => { throw new Error("No MediaUnderstandingProvider registered"); },
    {},
    models
  );
  const result = await provider.inspectPackage(snapshot, context);
  assert.equal(result.availability, "unavailable");
  assert.equal(result.failureReason, "provider_not_registered");
  assert.equal(result.packagePresent, "uncertain");
});

test("correlation distinguishes a strong single candidate from ambiguity", () => {
  const at = context.occurredAt;
  const delivery = (tracking, status) => normalizeDelivery({
    carrier_code: "ups",
    tracking_number: tracking,
    description: "Synthetic",
    status_code: status,
    date_expected: at,
    events: [],
  }, at);
  let state = applyObservations(createEmptyMonitorState(at), [delivery("ONE", 4)], at).state;
  const vision = { availability: "available", packagePresent: "yes", confidence: 0.9, observations: [] };
  assert.equal(correlateParcelEvent(state.parcels, at, vision).outcome, "strong_single");

  state = applyObservations(state, [delivery("ONE", 4), delivery("TWO", 4)], at).state;
  assert.equal(correlateParcelEvent(state.parcels, at, vision).outcome, "multiple");
});
