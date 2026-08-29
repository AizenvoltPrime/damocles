import { computed, toValue, type Component, type ComputedRef, type MaybeRefOrGetter } from "vue";
import type { ToolCall } from "@shared/types/session";
import { IconCheckCircle, IconXCircle, IconBan, IconQuestionCircle } from "@/components/icons";

type ToolStatus = ToolCall["status"];

/** Null while a call is still in flight, where every card shows a spinner in the same slot. */
function iconFor(status: ToolStatus): Component | null {
  switch (status) {
    case "pending":
    case "running":
    case "awaiting_approval":
      return null;
    case "approved":
    case "completed":
      return IconCheckCircle;
    case "denied":
    case "failed":
      return IconXCircle;
    case "abandoned":
    case "cancelled":
      return IconBan;
    case "unrecorded":
      return IconQuestionCircle;
  }
}

function textClassFor(status: ToolStatus): string {
  switch (status) {
    case "running":
    case "awaiting_approval":
      return "text-primary";
    case "approved":
    case "completed":
      return "text-success";
    case "denied":
    case "failed":
      return "text-error";
    case "pending":
    case "abandoned":
    case "cancelled":
    case "unrecorded":
      return "text-muted-foreground";
  }
}

function borderClassFor(status: ToolStatus): string {
  switch (status) {
    case "awaiting_approval":
      return "border-primary/50 bg-primary/5";
    case "denied":
    case "failed":
      return "border-error/50";
    case "abandoned":
    case "cancelled":
    case "unrecorded":
      return "border-muted/50 opacity-60";
    case "completed":
      return "border-success/30";
    case "pending":
    case "running":
    case "approved":
      return "border-border";
  }
}

export interface ToolCardStatus {
  statusIcon: ComputedRef<Component | null>;
  statusClass: ComputedRef<string>;
  cardClass: ComputedRef<string>;
}

/** The five specialised cards share this mapping; ToolCallCard deliberately keeps a different one. */
export function useToolCardStatus(status: MaybeRefOrGetter<ToolStatus>): ToolCardStatus {
  return {
    statusIcon: computed(() => iconFor(toValue(status))),
    statusClass: computed(() => textClassFor(toValue(status))),
    cardClass: computed(() => borderClassFor(toValue(status))),
  };
}
