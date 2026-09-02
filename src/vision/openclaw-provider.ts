import type { SnapshotResult } from "../unifi/types.js";
import type {
  PackagePresence,
  VisionContext,
  VisionModelConfig,
  VisionProvider,
  VisionResult,
} from "./types.js";

interface StructuredExtractionResult {
  parsed?: unknown;
  text: string;
  provider?: string;
  model?: string;
}

type ExtractStructured = (params: {
  input: Array<{ type: "image"; buffer: Buffer; fileName: string; mime?: string }>;
  instructions: string;
  schemaName: string;
  jsonSchema: unknown;
  jsonMode: boolean;
  cfg: unknown;
  provider: string;
  model: string;
  profile?: string;
  timeoutMs: number;
}) => Promise<StructuredExtractionResult>;

const VISION_SCHEMA = {
  type: "object",
  properties: {
    packagePresent: { type: "string", enum: ["yes", "no", "uncertain"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    observations: { type: "array", items: { type: "string" }, maxItems: 8 },
  },
  required: ["packagePresent", "confidence", "observations"],
  additionalProperties: false,
};

function providerNotRegistered(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /No MediaUnderstandingProvider registered/i.test(text) ||
    /media understanding provider.*not registered/i.test(text);
}

function parseResult(result: StructuredExtractionResult): VisionResult | undefined {
  let value = result.parsed;
  if (!value && result.text) {
    try {
      value = JSON.parse(result.text);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const parsed = value as Record<string, unknown>;
  if (!["yes", "no", "uncertain"].includes(String(parsed.packagePresent))) return undefined;
  if (typeof parsed.confidence !== "number" || parsed.confidence < 0 || parsed.confidence > 1) return undefined;
  if (!Array.isArray(parsed.observations) || !parsed.observations.every((item) => typeof item === "string")) return undefined;
  return {
    availability: "available",
    packagePresent: parsed.packagePresent as PackagePresence,
    confidence: parsed.confidence,
    observations: parsed.observations as string[],
    provider: result.provider,
    model: result.model,
  };
}

export class OpenClawVisionProvider implements VisionProvider {
  constructor(
    private readonly extractStructured: ExtractStructured,
    private readonly openclawConfig: unknown,
    private readonly models: VisionModelConfig[],
    private readonly timeoutMs = 20_000
  ) {}

  async inspectPackage(snapshot: SnapshotResult, context: VisionContext): Promise<VisionResult> {
    const attempts: Array<{ provider: string; model: string; error: string }> = [];
    let allMissingRegistration = true;
    for (const selection of this.models) {
      try {
        const raw = await this.extractStructured({
          input: [{ type: "image", buffer: Buffer.from(snapshot.bytes), fileName: `${context.eventId}.jpg`, mime: snapshot.mimeType }],
          instructions:
            "Determine whether a delivered parcel or package is visibly present. Do not infer carrier identity, ownership, or delivery status. Use uncertain when obstructed or ambiguous.",
          schemaName: "parcel_camera_observation",
          jsonSchema: VISION_SCHEMA,
          jsonMode: true,
          cfg: this.openclawConfig,
          provider: selection.provider,
          model: selection.model,
          profile: selection.profile,
          timeoutMs: this.timeoutMs,
        });
        const parsed = parseResult(raw);
        if (parsed) return { ...parsed, provider: parsed.provider ?? selection.provider, model: parsed.model ?? selection.model, attempts };
        allMissingRegistration = false;
        attempts.push({ ...selection, error: "Vision provider returned an invalid structured response" });
      } catch (error) {
        if (!providerNotRegistered(error)) allMissingRegistration = false;
        attempts.push({
          provider: selection.provider,
          model: selection.model,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      availability: "unavailable",
      packagePresent: "uncertain",
      confidence: null,
      observations: [],
      failureReason: allMissingRegistration ? "provider_not_registered" : "provider_error",
      error: allMissingRegistration
        ? "No configured model has a registered MediaUnderstandingProvider"
        : "All configured vision model attempts failed",
      attempts,
    };
  }
}
