/**
 * OpenClaw plugin entry for Parcel package tracking.
 *
 * Registers 6 individual tools for delivery management:
 * - parcel_list, parcel_add (API-based)
 * - parcel_edit, parcel_remove (browser-based)
 * - parcel_carriers, parcel_status_codes (static reference)
 */

import { definePluginEntry, type OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";
import { type Static } from "@sinclair/typebox";
import { ParcelAPIClient } from "./lib/api-client.js";
import {
  listSchema,
  addSchema,
  editSchema,
  removeSchema,
  carriersSchema,
  statusCodesSchema,
  monitorPollSchema,
  monitorStatusSchema,
  monitorAttemptSchema,
  monitorAckSchema,
  cameraProcessSchema,
} from "./lib/schema.js";
import {
  handleList,
  handleAdd,
  handleEdit,
  handleRemove,
  handleCarriers,
  handleStatusCodes,
} from "./lib/handler.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MONITOR_CONFIG, ParcelMonitor } from "./monitor/poll.js";
import { FileMonitorStateStore } from "./monitor/state-store.js";
import { createUnifiIngressHandler } from "./unifi/ingress.js";
import type { ParcelCameraConfig } from "./unifi/types.js";
import { UnifiProtectSnapshotClient } from "./unifi/snapshot-client.js";
import { ParcelCameraProcessor } from "./unifi/processor.js";
import { OpenClawVisionProvider } from "./vision/openclaw-provider.js";
import type { VisionModelConfig } from "./vision/types.js";

type ListParams = Static<typeof listSchema>;
type AddParams = Static<typeof addSchema>;
type EditParams = Static<typeof editSchema>;
type RemoveParams = Static<typeof removeSchema>;

interface SecretRef {
  source: "env" | "file";
  provider: string;
  id: string;
}

interface PluginConfig {
  apiKey?: string | SecretRef;
  monitor?: {
    enabled?: boolean;
    heartbeatPrompt?: boolean;
    minIntervalMinutes?: number;
    maxRequestsPerHour?: number;
    missingPollThreshold?: number;
  };
  unifi?: {
    enabled?: boolean;
    ingressToken?: string | SecretRef;
    cameras?: ParcelCameraConfig[];
    protect?: {
      baseUrl?: string;
      apiKey?: string | SecretRef;
    };
  };
  vision?: {
    models?: VisionModelConfig[];
    timeoutMs?: number;
  };
}

function isSecretRef(value: unknown): value is SecretRef {
  return (
    typeof value === "object" &&
    value !== null &&
    "source" in value &&
    "provider" in value &&
    "id" in value
  );
}

/**
 * Follow an RFC 6901 JSON pointer into a parsed JSON document. Returns
 * undefined for missing paths or non-object traversals.
 *
 * Per RFC 6901: empty string `""` → root document, `"/"` → the member with
 * the empty-string key (i.e. `doc[""]`), `"/a/b"` → `doc.a.b`. Everything
 * else traverses normally with `~0`/`~1` un-escaping for `~`/`/` in keys.
 */
function jsonPointer(doc: unknown, pointer: string): unknown {
  if (!pointer) return doc;
  const parts = pointer
    .replace(/^\//, "")
    .split("/")
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur: unknown = doc;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

async function resolveSecretRef(ref: SecretRef): Promise<string | undefined> {
  switch (ref.source) {
    case "env":
      return process.env[ref.id] || undefined;
    case "file":
      // OpenClaw shared-secrets-store: read ~/.openclaw/secrets.json and
      // follow ref.id as a JSON pointer. Matches the pattern used by
      // travel-hub, easypost, restaurant-cli, porsche-connect, instapaper.
      if (ref.provider === "secrets") {
        const secretsPath = join(homedir(), ".openclaw", "secrets.json");
        if (!existsSync(secretsPath)) return undefined;
        try {
          const doc = JSON.parse(readFileSync(secretsPath, "utf8"));
          const v = jsonPointer(doc, ref.id);
          return typeof v === "string" && v ? v : undefined;
        } catch {
          return undefined;
        }
      }
      return undefined;
    default:
      return undefined;
  }
}

async function resolveApiKey(config?: PluginConfig): Promise<string | undefined> {
  const configValue = config?.apiKey;
  if (isSecretRef(configValue)) {
    const resolved = await resolveSecretRef(configValue);
    if (resolved) return resolved;
  }
  if (typeof configValue === "string" && configValue) return configValue;
  if (process.env.PARCEL_API_KEY) return process.env.PARCEL_API_KEY;
  return undefined;
}

/** Helper to wrap a handler result as tool output. */
function toolResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: null,
  };
}

function toToolResult(result: Record<string, unknown>) {
  return toolResult(JSON.stringify(result, null, 2));
}

function errorResult(message: string) {
  return toToolResult({ success: false, error: message });
}

const pluginEntry: OpenClawPluginDefinition = definePluginEntry({
  id: "openclaw-parcel",
  name: "Parcel",
  description: "Track, add, edit, and remove package deliveries via the Parcel app",

  register(api) {
    const config = api.pluginConfig as PluginConfig | undefined;

    // Cache the ParcelAPIClient across tool calls — config and the SecretRef
    // don't change without a gateway restart (which re-runs register), so
    // resolving the key once per registration avoids re-reading secrets.json
    // on every tool invocation.
    let cachedClient: ParcelAPIClient | null = null;
    let cachedMonitor: ParcelMonitor | null = null;
    let cachedCameraProcessor: ParcelCameraProcessor | null = null;
    const stateStore = new FileMonitorStateStore(
      join(api.runtime.state.resolveStateDir(), "plugins", "openclaw-parcel")
    );

    async function getApiClient(): Promise<ParcelAPIClient | null> {
      if (cachedClient) return cachedClient;
      const apiKey = await resolveApiKey(config);
      if (!apiKey) return null;
      cachedClient = new ParcelAPIClient(apiKey);
      return cachedClient;
    }

    async function getMonitor(): Promise<ParcelMonitor> {
      if (cachedMonitor) return cachedMonitor;
      const client = await getApiClient();
      const monitorConfig = config?.monitor;
      cachedMonitor = new ParcelMonitor(
        client,
        stateStore,
        {
          minIntervalMinutes:
            monitorConfig?.minIntervalMinutes ?? DEFAULT_MONITOR_CONFIG.minIntervalMinutes,
          maxRequestsPerHour:
            monitorConfig?.maxRequestsPerHour ?? DEFAULT_MONITOR_CONFIG.maxRequestsPerHour,
          missingPollThreshold:
            monitorConfig?.missingPollThreshold ?? DEFAULT_MONITOR_CONFIG.missingPollThreshold,
        }
      );
      return cachedMonitor;
    }

    async function getCameraProcessor(): Promise<ParcelCameraProcessor | null> {
      if (cachedCameraProcessor) return cachedCameraProcessor;
      const protect = config?.unifi?.protect;
      const models = config?.vision?.models ?? [];
      if (!protect?.baseUrl || !protect.apiKey || models.length === 0) return null;
      const protectApiKey = isSecretRef(protect.apiKey)
        ? await resolveSecretRef(protect.apiKey)
        : protect.apiKey;
      if (!protectApiKey) return null;
      const snapshots = new UnifiProtectSnapshotClient(protect.baseUrl, protectApiKey);
      const vision = new OpenClawVisionProvider(
        (params) => api.runtime.mediaUnderstanding.extractStructuredWithModel(params as never),
        api.config,
        models,
        config?.vision?.timeoutMs
      );
      cachedCameraProcessor = new ParcelCameraProcessor(stateStore, snapshots, vision);
      return cachedCameraProcessor;
    }

    // --- parcel_list ---
    api.registerTool({
      name: "parcel_list",
      label: "Parcel List",
      description:
        "List active and recent package deliveries from Parcel. Returns tracking info, status, carrier, and estimated delivery dates.",
      parameters: listSchema,
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const client = await getApiClient();
        if (!client) return errorResult("No Parcel API key configured.");
        try {
          return toToolResult(await handleList(params as ListParams, client));
        } catch (e: unknown) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      },
    });

    // --- parcel_add ---
    api.registerTool({
      name: "parcel_add",
      label: "Parcel Add",
      description:
        "Add a new package to Parcel for tracking. Requires tracking number, carrier code, and description. Use parcel_carriers to look up carrier codes.",
      parameters: addSchema,
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const client = await getApiClient();
        if (!client) return errorResult("No Parcel API key configured.");
        try {
          return toToolResult(await handleAdd(params as AddParams, client));
        } catch (e: unknown) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      },
    });

    // --- parcel_edit ---
    api.registerTool({
      name: "parcel_edit",
      label: "Parcel Edit",
      description:
        "Edit a delivery's description on web.parcelapp.net. Returns browser automation instructions for OpenClaw's browser tool.",
      parameters: editSchema,
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          return toToolResult(handleEdit(params as EditParams));
        } catch (e: unknown) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      },
    });

    // --- parcel_remove ---
    api.registerTool({
      name: "parcel_remove",
      label: "Parcel Remove",
      description:
        "Remove a delivery from Parcel on web.parcelapp.net. Returns browser automation instructions for OpenClaw's browser tool.",
      parameters: removeSchema,
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          return toToolResult(handleRemove(params as RemoveParams));
        } catch (e: unknown) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      },
    });

    // --- parcel_carriers ---
    api.registerTool({
      name: "parcel_carriers",
      label: "Parcel Carriers",
      description:
        "List supported carrier codes for adding deliveries to Parcel (ups, fedex, usps, dhl, amazon, etc.).",
      parameters: carriersSchema,
      async execute() {
        return toToolResult(handleCarriers());
      },
    });

    // --- parcel_status_codes ---
    api.registerTool({
      name: "parcel_status_codes",
      label: "Parcel Status Codes",
      description:
        "Reference for Parcel delivery status codes and their meanings (0=Delivered, 2=In transit, etc.).",
      parameters: statusCodesSchema,
      async execute() {
        return toToolResult(handleStatusCodes());
      },
    });

    api.registerTool({
      name: "parcel_monitor_poll",
      label: "Parcel Monitor Poll",
      description:
        "Run one rate-limited Parcel monitor poll and return durable pending notifications. Does not deliver or acknowledge them.",
      parameters: monitorPollSchema,
      async execute() {
        if (config?.monitor?.enabled === false) return errorResult("Parcel monitoring is disabled.");
        const monitor = await getMonitor();
        try {
          return toToolResult(await monitor.poll());
        } catch (e: unknown) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      },
    });

    api.registerTool({
      name: "parcel_monitor_status",
      label: "Parcel Monitor Status",
      description: "Return monitor health and durable pending notifications without calling Parcel.",
      parameters: monitorStatusSchema,
      async execute() {
        const monitor = await getMonitor();
        try {
          const status = await monitor.status();
          return toToolResult({
            success: true,
            revision: status.state.revision,
            baselineEstablished: status.state.baselineEstablished,
            health: status.health,
            pollControl: status.state.pollControl,
            pendingNotifications: status.pendingNotifications,
          });
        } catch (e: unknown) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      },
    });

    api.registerTool({
      name: "parcel_monitor_attempt",
      label: "Parcel Monitor Attempt",
      description: "Record that transport delivery of a pending notification is about to be attempted.",
      parameters: monitorAttemptSchema,
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const monitor = await getMonitor();
        try {
          return toToolResult({
            success: true,
            notification: await monitor.recordAttempt(String(params.notification_id)),
          });
        } catch (e: unknown) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      },
    });

    api.registerTool({
      name: "parcel_monitor_ack",
      label: "Parcel Monitor Acknowledge",
      description: "Acknowledge a notification only after its transport reports successful delivery.",
      parameters: monitorAckSchema,
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const monitor = await getMonitor();
        try {
          return toToolResult({
            success: true,
            notification: await monitor.acknowledge(String(params.notification_id)),
          });
        } catch (e: unknown) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      },
    });

    api.registerTool({
      name: "parcel_camera_process",
      label: "Parcel Camera Process",
      description:
        "Resume one durable parcel-camera event through snapshot, vision, correlation, and notification outbox processing.",
      parameters: cameraProcessSchema,
      async execute() {
        const processor = await getCameraProcessor();
        if (!processor) {
          return errorResult("Parcel camera processing requires UniFi Protect and vision model configuration.");
        }
        try {
          return toToolResult(await processor.processNext());
        } catch (e: unknown) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      },
    });

    if (config?.monitor?.enabled !== false && config?.monitor?.heartbeatPrompt !== false) {
      api.on("heartbeat_prompt_contribution", () => ({
        appendContext:
          "Parcel monitoring: call parcel_monitor_poll once, then parcel_camera_process until it reports idle. For each pending notification, call parcel_monitor_attempt, deliver its payload using the configured message tool, and call parcel_monitor_ack only after the transport reports success. Leave failed deliveries pending. Finish with parcel_monitor_status; if health is degraded, surface an operator-visible warning and do not return a silent/OK heartbeat response.",
      }));
    }

    if (config?.unifi?.enabled && config.unifi.cameras?.length) {
      api.registerHttpRoute({
        path: "/plugins/openclaw-parcel/unifi/events",
        auth: "plugin",
        match: "exact",
        handler: createUnifiIngressHandler(
          stateStore,
          config.unifi.cameras,
          async () => {
            const token = config.unifi?.ingressToken;
            return isSecretRef(token) ? resolveSecretRef(token) : token;
          },
          async () => {
            const processor = await getCameraProcessor();
            return processor?.processNext();
          }
        ),
      });
    }
  },
});

export default pluginEntry;
