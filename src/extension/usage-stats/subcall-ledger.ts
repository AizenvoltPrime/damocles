import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { carriesUsage } from "../../shared/usage-accounting";
import { SUBCALL_USAGE_LEDGER_PATH } from "../paths";
import { log } from "../logger";

export type SubCallPurpose =
  | "session-title"
  | "memory-rerank"
  | "memory-extract"
  | "memory-merge"
  | "memory-profile"
  | "memory-query-expansion"
  | "btw";

export interface SubCallAttribution {
  cwd?: string;
  sessionId?: string;
}

export interface SubCallRecord {
  v: 1;
  type: "subcall";
  id: string;
  timestamp: string;
  purpose: SubCallPurpose;
  provider: string;
  model: string;
  stopReason: string;
  cwd: string | null;
  sessionId: string | null;
  usage: AssistantMessage["usage"];
}

/**
 * Record one sub-call's usage, or nothing when it billed nothing. A single `appendFileSync` per line keeps
 * concurrent VS Code windows from interleaving records. Never throws: losing a ledger line must not fail
 * the sub-call it describes.
 */
export function appendSubCallUsage(
  message: Pick<AssistantMessage, "provider" | "model" | "stopReason" | "usage">,
  purpose: SubCallPurpose,
  attribution: SubCallAttribution = {},
  ledgerPath: string = SUBCALL_USAGE_LEDGER_PATH,
): void {
  if (!carriesUsage(message.usage)) return;
  const record: SubCallRecord = {
    v: 1,
    type: "subcall",
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    purpose,
    provider: message.provider,
    model: message.model,
    stopReason: message.stopReason,
    cwd: attribution.cwd ?? null,
    sessionId: attribution.sessionId ?? null,
    usage: message.usage,
  };
  try {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`, "utf8");
  } catch (err) {
    log("[SubCallLedger] could not record %s usage: %O", purpose, err);
  }
}
