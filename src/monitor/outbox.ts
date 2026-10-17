import { STATUS_CODES } from "../lib/carriers.js";
import type {
  MonitorState,
  NotificationRecord,
  ParcelChange,
  StoredParcel,
} from "./model.js";
import { stableId } from "./model.js";

export interface NotificationPolicy {
  alertStatusCodes: number[];
  alertOnNewParcel: boolean;
  alertOnReactivatedParcel: boolean;
}

export const DEFAULT_NOTIFICATION_POLICY: NotificationPolicy = {
  alertStatusCodes: [0, 2, 3, 4, 6, 7, 8],
  alertOnNewParcel: true,
  alertOnReactivatedParcel: true,
};

export interface EnqueueOptions {
  suppress: boolean;
  policy?: NotificationPolicy;
}

function shouldNotify(change: ParcelChange, policy: NotificationPolicy): boolean {
  if (change.kind === "status_changed") {
    return typeof change.after === "number" && policy.alertStatusCodes.includes(change.after);
  }
  if (change.kind === "first_seen") return policy.alertOnNewParcel;
  if (change.kind === "reactivated") return policy.alertOnReactivatedParcel;
  return false;
}

function notificationPayload(change: ParcelChange, parcel: StoredParcel): Record<string, unknown> {
  return {
    kind: "parcel_change",
    changeId: change.changeId,
    changeKind: change.kind,
    parcel: {
      parcelKey: parcel.parcelKey,
      carrierCode: parcel.latest.carrierCode,
      trackingNumber: parcel.latest.trackingNumber,
      description: parcel.latest.description,
      statusCode: parcel.latest.statusCode,
      status: STATUS_CODES[parcel.latest.statusCode] ?? "Unknown",
      expectedAt: parcel.latest.expectedAt,
      latestEvent: parcel.latest.latestEvent,
    },
  };
}

export function enqueueNotifications(
  input: MonitorState,
  changes: ParcelChange[],
  now: string,
  options: EnqueueOptions
): { state: MonitorState; enqueued: NotificationRecord[] } {
  const state = structuredClone(input);
  if (options.suppress) return { state, enqueued: [] };
  const policy = options.policy ?? DEFAULT_NOTIFICATION_POLICY;
  const enqueued: NotificationRecord[] = [];

  for (const change of changes) {
    if (!shouldNotify(change, policy)) continue;
    const parcel = state.parcels[change.parcelKey];
    if (!parcel) continue;
    const notificationId = stableId("notification", {
      kind: "parcel_change",
      changeIds: [change.changeId],
    });
    if (state.notifications[notificationId]) continue;
    const record: NotificationRecord = {
      notificationId,
      status: "pending",
      createdAt: now,
      attemptCount: 0,
      changeIds: [change.changeId],
      payload: notificationPayload(change, parcel),
    };
    state.notifications[notificationId] = record;
    enqueued.push(record);
  }
  state.updatedAt = now;
  return { state, enqueued };
}

export function pendingNotifications(state: MonitorState): NotificationRecord[] {
  return Object.values(state.notifications)
    .filter((item) => item.status === "pending")
    .sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.notificationId.localeCompare(right.notificationId)
    );
}

export function enqueuePayloadNotification(
  input: MonitorState,
  kind: string,
  semanticId: string,
  payload: Record<string, unknown>,
  now: string
): { state: MonitorState; notification: NotificationRecord; created: boolean } {
  const state = structuredClone(input);
  const notificationId = stableId("notification", { kind, semanticId });
  const existing = state.notifications[notificationId];
  if (existing) return { state, notification: existing, created: false };
  const notification: NotificationRecord = {
    notificationId,
    status: "pending",
    createdAt: now,
    attemptCount: 0,
    changeIds: [],
    payload: { kind, ...payload },
  };
  state.notifications[notificationId] = notification;
  state.updatedAt = now;
  return { state, notification, created: true };
}

export function recordNotificationAttempt(
  input: MonitorState,
  notificationId: string,
  attemptedAt: string
): MonitorState {
  const state = structuredClone(input);
  const notification = state.notifications[notificationId];
  if (!notification) throw new Error(`Unknown notification ${notificationId}`);
  if (notification.status === "acknowledged") return state;
  notification.attemptCount += 1;
  notification.lastAttemptAt = attemptedAt;
  state.updatedAt = attemptedAt;
  return state;
}

export function acknowledgeNotification(
  input: MonitorState,
  notificationId: string,
  acknowledgedAt: string
): MonitorState {
  const state = structuredClone(input);
  const notification = state.notifications[notificationId];
  if (!notification) throw new Error(`Unknown notification ${notificationId}`);
  if (notification.status === "acknowledged") return state;
  notification.status = "acknowledged";
  notification.acknowledgedAt = acknowledgedAt;
  state.updatedAt = acknowledgedAt;
  return state;
}
