import { stableId } from "../monitor/model.js";
import type { NormalizedUnifiEvent, ParcelCameraConfig } from "./types.js";

export class UnifiEventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnifiEventValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item) => {
      if (typeof item === "string") return [item];
      if (isRecord(item)) return [firstString(item.type, item.name, item.key)].filter(Boolean) as string[];
      return [];
    })
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .sort();
}

export function normalizeUnifiEvent(
  value: unknown,
  cameras: ParcelCameraConfig[]
): { event: NormalizedUnifiEvent; camera: ParcelCameraConfig } {
  if (!isRecord(value)) throw new UnifiEventValidationError("UniFi event body must be an object");
  const device = isRecord(value.device) ? value.device : {};
  const externalCameraId = firstString(
    value.camera_id,
    value.cameraId,
    value.externalCameraId,
    value.device_id,
    value.deviceId,
    device.id,
    device.mac
  );
  if (!externalCameraId) throw new UnifiEventValidationError("UniFi event is missing a camera identifier");
  const camera = cameras.find((candidate) => candidate.externalId === externalCameraId);
  if (!camera) throw new UnifiEventValidationError("UniFi event camera is not configured for parcel monitoring");
  if (!camera.roles.includes("parcel")) {
    throw new UnifiEventValidationError("UniFi event camera does not have the parcel role");
  }
  const occurredAt = firstString(value.timestamp, value.occurred_at, value.occurredAt, value.start) ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(occurredAt))) {
    throw new UnifiEventValidationError("UniFi event timestamp is invalid");
  }
  const alarmName = firstString(value.alarm, value.alarm_name, value.alarmName, value.name, value.type) ?? "unknown";
  const triggerTypes = stringList(value.triggers);
  const eventType = firstString(value.eventType);
  if (eventType && !triggerTypes.includes(eventType.toLowerCase())) {
    triggerTypes.push(eventType.toLowerCase());
    triggerTypes.sort();
  }
  const suppliedId = firstString(value.event_id, value.eventId, value.id);
  const eventId = suppliedId
    ? (suppliedId.startsWith("unifi_") ? suppliedId : `unifi_${suppliedId}`)
    : stableId("unifi", { externalCameraId, occurredAt, alarmName, triggerTypes });

  return {
    camera,
    event: { eventId, externalCameraId, occurredAt, alarmName, triggerTypes, raw: value },
  };
}
