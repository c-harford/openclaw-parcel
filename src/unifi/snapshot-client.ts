import type { SnapshotProvider, SnapshotRequest, SnapshotResult } from "./types.js";

export class UnifiSnapshotError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "UnifiSnapshotError";
    this.status = status;
  }
}

export class UnifiProtectSnapshotClient implements SnapshotProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 15_000
  ) {}

  async getSnapshot(request: SnapshotRequest): Promise<SnapshotResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const channel = request.channel ? `?channel=${encodeURIComponent(request.channel)}` : "";
    const url = `${this.baseUrl.replace(/\/$/, "")}/proxy/protect/integration/v1/cameras/${encodeURIComponent(request.protectCameraId)}/snapshot${channel}`;
    try {
      const response = await this.fetchImpl(url, {
        headers: { "X-API-KEY": this.apiKey },
        signal: controller.signal,
      });
      if (!response.ok) throw new UnifiSnapshotError(`UniFi snapshot returned HTTP ${response.status}`, response.status);
      const mimeType = response.headers.get("content-type")?.split(";")[0] || "image/jpeg";
      return { bytes: new Uint8Array(await response.arrayBuffer()), mimeType };
    } catch (error) {
      if (controller.signal.aborted) throw new UnifiSnapshotError(`UniFi snapshot timed out after ${this.timeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
