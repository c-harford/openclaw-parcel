import type { MonitorState } from "./model.js";

export interface RateGateConfig {
  minIntervalMinutes: number;
  maxRequestsPerHour: number;
}

export const DEFAULT_RATE_GATE: RateGateConfig = {
  minIntervalMinutes: 10,
  maxRequestsPerHour: 18,
};

export interface RateDecision {
  allowed: boolean;
  retryAt?: string;
  reason?: "minimum_interval" | "hourly_limit" | "remote_limit";
}

export function rateDecision(
  state: MonitorState,
  now: Date,
  config: RateGateConfig = DEFAULT_RATE_GATE
): RateDecision {
  const nextAllowed = state.pollControl.nextAllowedAt
    ? new Date(state.pollControl.nextAllowedAt)
    : undefined;
  if (nextAllowed && nextAllowed.getTime() > now.getTime()) {
    return { allowed: false, retryAt: nextAllowed.toISOString(), reason: "remote_limit" };
  }
  if (state.pollControl.lastAttemptAt) {
    const minimum = new Date(
      Date.parse(state.pollControl.lastAttemptAt) + config.minIntervalMinutes * 60_000
    );
    if (minimum.getTime() > now.getTime()) {
      return { allowed: false, retryAt: minimum.toISOString(), reason: "minimum_interval" };
    }
  }
  const windowStart = now.getTime() - 60 * 60_000;
  const attempts = state.pollControl.requestAttempts
    .map((value) => new Date(value))
    .filter((date) => !Number.isNaN(date.getTime()) && date.getTime() > windowStart)
    .sort((a, b) => a.getTime() - b.getTime());
  if (attempts.length >= config.maxRequestsPerHour) {
    return {
      allowed: false,
      retryAt: new Date(attempts[0].getTime() + 60 * 60_000).toISOString(),
      reason: "hourly_limit",
    };
  }
  return { allowed: true };
}

export function recordRequestAttempt(state: MonitorState, now: Date): MonitorState {
  const result = structuredClone(state);
  const windowStart = now.getTime() - 60 * 60_000;
  result.pollControl.requestAttempts = result.pollControl.requestAttempts.filter(
    (value) => Date.parse(value) > windowStart
  );
  const nowIso = now.toISOString();
  result.pollControl.requestAttempts.push(nowIso);
  result.pollControl.lastAttemptAt = nowIso;
  result.updatedAt = nowIso;
  return result;
}

export function applyRemoteRetryAfter(
  state: MonitorState,
  now: Date,
  retryAfterSeconds: number
): MonitorState {
  const result = structuredClone(state);
  const candidate = now.getTime() + retryAfterSeconds * 1_000;
  const existing = result.pollControl.nextAllowedAt
    ? Date.parse(result.pollControl.nextAllowedAt)
    : 0;
  result.pollControl.nextAllowedAt = new Date(Math.max(candidate, existing)).toISOString();
  return result;
}
