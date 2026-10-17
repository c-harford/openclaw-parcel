import type { SnapshotResult } from "../unifi/types.js";

export type PackagePresence = "yes" | "no" | "uncertain";

export interface VisionResult {
  availability: "available" | "unavailable";
  packagePresent: PackagePresence;
  confidence: number | null;
  observations: string[];
  provider?: string;
  model?: string;
  failureReason?: "provider_not_registered" | "provider_error" | "invalid_response" | "snapshot_error";
  error?: string;
  attempts?: Array<{ provider: string; model: string; error: string }>;
}

export interface VisionContext {
  eventId: string;
  cameraRole: string[];
  occurredAt: string;
}

export interface VisionProvider {
  inspectPackage(snapshot: SnapshotResult, context: VisionContext): Promise<VisionResult>;
}

export interface VisionModelConfig {
  provider: string;
  model: string;
  profile?: string;
}
