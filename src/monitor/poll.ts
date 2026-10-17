import { ParcelAPIError, type ParcelAPIClient } from "../lib/api-client.js";
import { applyObservations } from "./diff.js";
import { normalizeDelivery, type MonitorState, type NotificationRecord } from "./model.js";
import {
  acknowledgeNotification,
  enqueueNotifications,
  pendingNotifications,
  recordNotificationAttempt,
} from "./outbox.js";
import {
  applyRemoteRetryAfter,
  DEFAULT_RATE_GATE,
  rateDecision,
  recordRequestAttempt,
  type RateGateConfig,
} from "./rate-gate.js";
import { FileMonitorStateStore } from "./state-store.js";

export interface ParcelMonitorConfig extends RateGateConfig {
  missingPollThreshold: number;
}

export const DEFAULT_MONITOR_CONFIG: ParcelMonitorConfig = {
  ...DEFAULT_RATE_GATE,
  missingPollThreshold: 2,
};

export type PollOutcome =
  | { outcome: "success"; baselineEstablished: boolean; observedCount: number; changeCount: number; enqueuedCount: number; pendingNotifications: NotificationRecord[] }
  | { outcome: "skipped"; reason: string; retryAt?: string; pendingNotifications: NotificationRecord[] }
  | { outcome: "error"; errorType: string; error: string; retryAt?: string; pendingNotifications: NotificationRecord[] };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface MonitorHealth {
  status: "healthy" | "degraded";
  indicators: Array<{
    code: "poll_failure" | "notification_not_attempted" | "notification_delivery_unacknowledged";
    detail: string;
  }>;
}

export function monitorHealth(
  state: MonitorState,
  now = new Date(),
  staleNotificationMinutes = 15
): MonitorHealth {
  const indicators: MonitorHealth["indicators"] = [];
  if (
    state.pollControl.lastFailureAt &&
    (!state.pollControl.lastSuccessAt ||
      Date.parse(state.pollControl.lastFailureAt) > Date.parse(state.pollControl.lastSuccessAt))
  ) {
    indicators.push({
      code: "poll_failure",
      detail: state.pollControl.lastFailure ?? "The latest Parcel poll failed",
    });
  }
  const staleBefore = now.getTime() - staleNotificationMinutes * 60_000;
  for (const notification of pendingNotifications(state)) {
    const reference = notification.lastAttemptAt ?? notification.createdAt;
    if (Date.parse(reference) >= staleBefore) continue;
    indicators.push({
      code:
        notification.attemptCount > 0
          ? "notification_delivery_unacknowledged"
          : "notification_not_attempted",
      detail: `${notification.notificationId} has been pending since ${reference}`,
    });
  }
  return { status: indicators.length ? "degraded" : "healthy", indicators };
}

export class ParcelMonitor {
  constructor(
    private readonly apiClient: Pick<ParcelAPIClient, "getDeliveries"> | null,
    private readonly store: FileMonitorStateStore,
    private readonly config: ParcelMonitorConfig = DEFAULT_MONITOR_CONFIG,
    private readonly now: () => Date = () => new Date()
  ) {}

  async poll(): Promise<PollOutcome> {
    return this.store.withLock(async () => {
      let state = await this.store.load();
      if (!this.apiClient) {
        return {
          outcome: "error",
          errorType: "ParcelAPIConfigurationError",
          error: "No Parcel API key configured.",
          pendingNotifications: pendingNotifications(state),
        };
      }
      const current = this.now();
      const decision = rateDecision(state, current, this.config);
      if (!decision.allowed) {
        return { outcome: "skipped", reason: decision.reason ?? "not_due", retryAt: decision.retryAt, pendingNotifications: pendingNotifications(state) };
      }

      state = await this.store.save(recordRequestAttempt(state, current));
      try {
        const response = await this.apiClient.getDeliveries("active");
        if (!response.success) throw new Error(response.error_message || "Parcel API reported an unsuccessful response");
        const observedAt = current.toISOString();
        const observations = response.deliveries.map((delivery) => normalizeDelivery(delivery, observedAt));
        const wasBaselineEstablished = state.baselineEstablished;
        const applied = applyObservations(state, observations, observedAt, this.config.missingPollThreshold);
        const queued = enqueueNotifications(applied.state, applied.changes, observedAt, { suppress: !wasBaselineEstablished });
        queued.state.pollControl.lastSuccessAt = observedAt;
        delete queued.state.pollControl.lastFailureAt;
        delete queued.state.pollControl.lastFailure;
        delete queued.state.pollControl.nextAllowedAt;
        state = await this.store.save(queued.state);
        return {
          outcome: "success",
          baselineEstablished: !wasBaselineEstablished,
          observedCount: observations.length,
          changeCount: applied.changes.length,
          enqueuedCount: queued.enqueued.length,
          pendingNotifications: pendingNotifications(state),
        };
      } catch (error) {
        const failedAt = this.now();
        state.pollControl.lastFailureAt = failedAt.toISOString();
        state.pollControl.lastFailure = errorMessage(error);
        state.updatedAt = failedAt.toISOString();
        if (error instanceof ParcelAPIError && error.retryAfterSeconds !== undefined) {
          state = applyRemoteRetryAfter(state, failedAt, error.retryAfterSeconds);
        }
        state = await this.store.save(state);
        return {
          outcome: "error",
          errorType: error instanceof Error ? error.name : "UnknownError",
          error: errorMessage(error),
          retryAt: state.pollControl.nextAllowedAt,
          pendingNotifications: pendingNotifications(state),
        };
      }
    });
  }

  async status(): Promise<{
    state: MonitorState;
    health: MonitorHealth;
    pendingNotifications: NotificationRecord[];
  }> {
    const state = await this.store.load();
    return {
      state,
      health: monitorHealth(state, this.now()),
      pendingNotifications: pendingNotifications(state),
    };
  }

  async recordAttempt(notificationId: string): Promise<NotificationRecord> {
    return this.store.withLock(async () => {
      let state = await this.store.load();
      state = await this.store.save(recordNotificationAttempt(state, notificationId, this.now().toISOString()));
      return state.notifications[notificationId];
    });
  }

  async acknowledge(notificationId: string): Promise<NotificationRecord> {
    return this.store.withLock(async () => {
      let state = await this.store.load();
      state = await this.store.save(acknowledgeNotification(state, notificationId, this.now().toISOString()));
      return state.notifications[notificationId];
    });
  }
}
