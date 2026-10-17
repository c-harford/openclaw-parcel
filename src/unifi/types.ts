export interface ParcelCameraConfig {
  externalId: string;
  protectCameraId: string;
  roles: string[];
  snapshotChannel?: string;
}

export interface NormalizedUnifiEvent {
  eventId: string;
  externalCameraId: string;
  occurredAt: string;
  alarmName: string;
  triggerTypes: string[];
  raw: Record<string, unknown>;
}

export interface SnapshotRequest {
  protectCameraId: string;
  channel?: string;
}

export interface SnapshotResult {
  bytes: Uint8Array;
  mimeType: string;
}

export interface SnapshotProvider {
  getSnapshot(request: SnapshotRequest): Promise<SnapshotResult>;
}
