import type { FileMonitorStateStore } from "../monitor/state-store.js";
import { enqueuePayloadNotification } from "../monitor/outbox.js";
import { correlateParcelEvent } from "../vision/correlation.js";
import type { VisionProvider, VisionResult } from "../vision/types.js";
import type { SnapshotProvider } from "./types.js";

export class ParcelCameraProcessor {
  constructor(
    private readonly store: FileMonitorStateStore,
    private readonly snapshots: SnapshotProvider,
    private readonly vision: VisionProvider,
    private readonly now: () => Date = () => new Date()
  ) {}

  async processNext(): Promise<Record<string, unknown>> {
    const selected = await this.store.withLock(async () => {
      let state = await this.store.load();
      const event = Object.values(state.unifiEvents)
        .filter(
          (candidate) =>
            candidate.stage === "received" ||
            (candidate.stage === "processing" &&
              Date.parse(candidate.updatedAt) < this.now().getTime() - 5 * 60_000)
        )
        .sort((left, right) => left.receivedAt.localeCompare(right.receivedAt))[0];
      if (!event) return undefined;
      event.stage = "processing";
      event.updatedAt = this.now().toISOString();
      state.updatedAt = event.updatedAt;
      await this.store.save(state);
      return structuredClone(event);
    });
    if (!selected) return { outcome: "idle" };

    const normalized = selected.data.normalized as Record<string, unknown>;
    const camera = selected.data.camera as Record<string, unknown>;
    let vision: VisionResult;
    try {
      const snapshot = await this.snapshots.getSnapshot({
        protectCameraId: String(camera.protectCameraId),
        channel: typeof camera.snapshotChannel === "string" ? camera.snapshotChannel : undefined,
      });
      try {
        vision = await this.vision.inspectPackage(snapshot, {
          eventId: selected.eventId,
          cameraRole: Array.isArray(camera.roles) ? camera.roles.map(String) : [],
          occurredAt: String(normalized.occurredAt),
        });
      } catch (error) {
        vision = {
          availability: "unavailable",
          packagePresent: "uncertain",
          confidence: null,
          observations: [],
          failureReason: "provider_error",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    } catch (error) {
      vision = {
        availability: "unavailable",
        packagePresent: "uncertain",
        confidence: null,
        observations: [],
        failureReason: "snapshot_error",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    return this.store.withLock(async () => {
      let state = await this.store.load();
      const current = state.unifiEvents[selected.eventId];
      if (!current) throw new Error(`UniFi event ${selected.eventId} disappeared during processing`);
      const correlation = correlateParcelEvent(state.parcels, String(normalized.occurredAt), vision);
      const processedAt = this.now().toISOString();
      current.stage = vision.availability === "available" ? "processed" : "vision_unavailable";
      current.updatedAt = processedAt;
      current.data.vision = vision;
      current.data.correlation = correlation;

      if (vision.availability === "unavailable") {
        state = enqueuePayloadNotification(
          state,
          "parcel_camera_vision_unavailable",
          selected.eventId,
          { eventId: selected.eventId, vision },
          processedAt
        ).state;
      } else if (vision.packagePresent !== "no") {
        state = enqueuePayloadNotification(
          state,
          "parcel_camera_observation",
          selected.eventId,
          { eventId: selected.eventId, vision, correlation },
          processedAt
        ).state;
      }
      state.updatedAt = processedAt;
      await this.store.save(state);
      return { outcome: current.stage, eventId: selected.eventId, vision, correlation };
    });
  }
}
