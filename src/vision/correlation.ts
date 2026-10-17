import type { StoredParcel } from "../monitor/model.js";
import type { VisionResult } from "./types.js";

export interface CorrelationCandidate {
  parcelKey: string;
  score: number;
  reasons: string[];
}

export interface CorrelationResult {
  outcome: "strong_single" | "multiple" | "weak" | "none";
  candidates: CorrelationCandidate[];
}

function scoreParcel(parcel: StoredParcel, eventTime: Date): CorrelationCandidate {
  let score = 0;
  const reasons: string[] = [];
  const statusScores: Record<number, number> = { 4: 60, 0: 50, 3: 35, 2: 20 };
  const statusScore = statusScores[parcel.latest.statusCode] ?? 0;
  if (statusScore) {
    score += statusScore;
    reasons.push(`status_${parcel.latest.statusCode}`);
  }
  const expected = parcel.latest.expectedAt ? Date.parse(parcel.latest.expectedAt) : Number.NaN;
  if (!Number.isNaN(expected) && Math.abs(expected - eventTime.getTime()) <= 36 * 60 * 60_000) {
    score += 30;
    reasons.push("expected_near_event");
  }
  const latestText = parcel.latest.latestEvent?.description.toLowerCase() ?? "";
  if (/delivered|out for delivery|vehicle for delivery/.test(latestText)) {
    score += 20;
    reasons.push("delivery_event_text");
  }
  return { parcelKey: parcel.parcelKey, score, reasons };
}

export function correlateParcelEvent(
  parcels: Record<string, StoredParcel>,
  occurredAt: string,
  vision: VisionResult
): CorrelationResult {
  if (vision.availability !== "available" || vision.packagePresent === "no") {
    return { outcome: "none", candidates: [] };
  }
  const eventTime = new Date(occurredAt);
  const candidates = Object.values(parcels)
    .filter((parcel) => parcel.active)
    .map((parcel) => scoreParcel(parcel, eventTime))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.parcelKey.localeCompare(right.parcelKey));
  if (!candidates.length) return { outcome: "none", candidates };
  if (candidates[0].score >= 60 && (!candidates[1] || candidates[0].score - candidates[1].score >= 20)) {
    return { outcome: "strong_single", candidates: candidates.slice(0, 3) };
  }
  if (candidates[0].score >= 40 && candidates[1] && candidates[0].score - candidates[1].score < 20) {
    return { outcome: "multiple", candidates: candidates.slice(0, 3) };
  }
  return { outcome: "weak", candidates: candidates.slice(0, 3) };
}
