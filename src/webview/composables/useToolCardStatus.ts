import { computed, toValue, type Component, type ComputedRef, type MaybeRefOrGetter } from "vue";
import { useI18n } from "vue-i18n";
import type { ToolAbandonReason, ToolCall } from "@shared/types/session";
import { Ban, CircleCheck, CircleQuestionMark, CircleX, Hourglass, LoaderCircle, ShieldBan } from "lucide-vue-next";

type ToolStatus = ToolCall["status"];

type StatusIconKind = "spinner" | "waiting" | "done" | "blocked" | "failed" | "stopped" | "unrecorded";

const STATUS_ICONS: Record<StatusIconKind, Component> = {
  spinner: LoaderCircle,
  waiting: Hourglass,
  done: CircleCheck,
  blocked: ShieldBan,
  failed: CircleX,
  stopped: Ban,
  unrecorded: CircleQuestionMark,
};

function iconKindFor(status: ToolStatus): StatusIconKind {
  switch (status) {
    case "pending":
    case "running":
      return "spinner";
    case "awaiting_approval":
      return "waiting";
    case "approved":
    case "completed":
      return "done";
    case "blocked":
      return "blocked";
    case "denied":
    case "failed":
      return "failed";
    case "abandoned":
    case "cancelled":
      return "stopped";
    case "unrecorded":
      return "unrecorded";
  }
}

function motionFor(status: ToolStatus): string {
  return status === "pending" || status === "running" ? "d-spinning" : "";
}

function textClassFor(status: ToolStatus): string {
  switch (status) {
    case "running":
      return "text-(--d-accent)";
    case "awaiting_approval":
    case "blocked":
      return "text-(--d-warning)";
    case "approved":
    case "completed":
      return "text-(--d-success)";
    case "denied":
    case "failed":
      return "text-(--d-danger)";
    case "pending":
    case "abandoned":
    case "cancelled":
    case "unrecorded":
      return "text-(--d-faint)";
  }
}

function borderClassFor(status: ToolStatus): string {
  switch (status) {
    case "awaiting_approval":
    case "blocked":
      return "border-[color-mix(in_srgb,var(--d-warning-fill)_45%,var(--d-border))]";
    case "denied":
    case "failed":
      return "border-[color-mix(in_srgb,var(--d-danger-fill)_45%,var(--d-border))]";
    case "abandoned":
    case "cancelled":
    case "unrecorded":
      return "border-(--d-border) opacity-60";
    case "completed":
    case "pending":
    case "running":
    case "approved":
      return "border-(--d-border)";
  }
}

function labelKeyFor(status: ToolStatus): string {
  switch (status) {
    case "pending":
    case "running":
      return "toolOverlay.statusRunning";
    case "awaiting_approval":
      return "toolCall.awaitingApproval";
    case "approved":
      return "toolOverlay.statusApproved";
    case "denied":
      return "toolOverlay.statusDenied";
    case "blocked":
      return "toolOverlay.statusBlocked";
    case "completed":
      return "toolOverlay.statusCompleted";
    case "failed":
      return "toolOverlay.statusFailed";
    case "abandoned":
      return "toolCall.notExecuted";
    case "cancelled":
      return "toolOverlay.statusCancelled";
    case "unrecorded":
      return "toolOverlay.statusUnrecorded";
  }
}

function badgeToneFor(status: ToolStatus): string {
  switch (status) {
    case "pending":
    case "running":
      return "d-tone-accent";
    case "awaiting_approval":
    case "blocked":
      return "d-tone-warning";
    case "approved":
    case "completed":
      return "d-tone-success";
    case "denied":
    case "failed":
      return "d-tone-danger";
    case "abandoned":
    case "cancelled":
    case "unrecorded":
      return "d-tone-muted";
  }
}

/** A tool overlay's header chip (`OverlayShell` `statusBadge`), in the same vocabulary as the card. */
export function useToolStatusBadge(status: MaybeRefOrGetter<ToolStatus>): ComputedRef<{ label: string; class: string; pulse: boolean }> {
  const { t } = useI18n();
  return computed(() => {
    const s = toValue(status);
    return { label: t(labelKeyFor(s)), class: badgeToneFor(s), pulse: s === "pending" || s === "running" || s === "awaiting_approval" };
  });
}

export interface ToolCardStatus {
  statusIcon: ComputedRef<Component>;
  /** Which icon shows, for a Transition's key: a status change that keeps the icon (pending to running) replays nothing. */
  statusIconKind: ComputedRef<StatusIconKind>;
  /** The icon's colour and its motion.css class. */
  statusClass: ComputedRef<string>;
  /** The motion.css class alone, for an icon that takes its colour from a chip. */
  statusMotion: ComputedRef<string>;
  cardClass: ComputedRef<string>;
}

/** A tool card's `data-tool-status`, the values docs/themes.md promises theme CSS; the set may gain values, never lose one. */
export type ToolHookStatus = "running" | "done" | "error" | "blocked" | "stopped";

export function toolHookStatus(status: ToolStatus): ToolHookStatus {
  switch (status) {
    case "pending":
    case "running":
      return "running";
    case "awaiting_approval":
    case "blocked":
      return "blocked";
    case "approved":
    case "completed":
      return "done";
    case "denied":
    case "failed":
      return "error";
    case "abandoned":
    case "cancelled":
    case "unrecorded":
      return "stopped";
  }
}

/** The hook of an agent or team card, which draws its agent's or run's state, not its tool call's. */
export function agentHookStatus(status: "running" | "completed" | "failed" | "cancelled", awaitingUser = false): ToolHookStatus {
  if (status === "running") return awaitingUser ? "blocked" : "running";
  if (status === "completed") return "done";
  return status === "failed" ? "error" : "stopped";
}

/** A call's measured `execute()` time as its card's meta chip shows it. */
export function formatToolDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export interface ToolStatusNote {
  icon: Component;
  title: string;
  description: string | undefined;
}

const ABANDONED_DESCRIPTION_KEYS: Record<ToolAbandonReason, string> = {
  stopped: "toolCall.abandonedStopped",
  failed: "toolCall.abandonedFailed",
};

/** The note a card shows under a call that never ran, was cancelled, or whose outcome was not recorded; null otherwise. */
export function useToolStatusNote(status: MaybeRefOrGetter<ToolStatus>, abandonReason: MaybeRefOrGetter<ToolAbandonReason | undefined>): ComputedRef<ToolStatusNote | null> {
  const { t } = useI18n();
  return computed(() => {
    switch (toValue(status)) {
      case "abandoned": {
        const reason = toValue(abandonReason);
        return { icon: Ban, title: t("toolCall.notExecuted"), description: reason ? t(ABANDONED_DESCRIPTION_KEYS[reason]) : undefined };
      }
      case "cancelled":
        return { icon: Ban, title: t("toolCall.cancelled"), description: t("toolCall.cancelledDescription") };
      case "unrecorded":
        return { icon: CircleQuestionMark, title: t("toolCall.outcomeUnrecorded"), description: t("toolCall.outcomeUnrecordedDescription") };
      default:
        return null;
    }
  });
}

/** The one status vocabulary of every tool card (the reference's tool row, Chat Panel.dc.html m.isTool). */
export function useToolCardStatus(status: MaybeRefOrGetter<ToolStatus>): ToolCardStatus {
  return {
    statusIcon: computed(() => STATUS_ICONS[iconKindFor(toValue(status))]),
    statusIconKind: computed(() => iconKindFor(toValue(status))),
    statusClass: computed(() => [textClassFor(toValue(status)), motionFor(toValue(status))].filter(Boolean).join(" ")),
    statusMotion: computed(() => motionFor(toValue(status))),
    cardClass: computed(() => borderClassFor(toValue(status))),
  };
}
