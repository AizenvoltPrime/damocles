import { computed, toValue, type Component, type ComputedRef, type MaybeRefOrGetter } from "vue";
import { useI18n } from "vue-i18n";
import type { ToolCall } from "@shared/types/session";
import { Ban, CircleCheck, CircleQuestionMark, CircleX, Hourglass, LoaderCircle } from "lucide-vue-next";

type ToolStatus = ToolCall["status"];

function iconFor(status: ToolStatus): Component {
  switch (status) {
    case "pending":
    case "running":
      return LoaderCircle;
    case "awaiting_approval":
      return Hourglass;
    case "approved":
    case "completed":
      return CircleCheck;
    case "denied":
    case "failed":
      return CircleX;
    case "abandoned":
    case "cancelled":
      return Ban;
    case "unrecorded":
      return CircleQuestionMark;
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
      return "border-[color-mix(in_srgb,var(--d-warning)_45%,var(--d-border))]";
    case "denied":
    case "failed":
      return "border-[color-mix(in_srgb,var(--d-danger)_45%,var(--d-border))]";
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
  /** The icon's colour and its motion.css class. */
  statusClass: ComputedRef<string>;
  /** The motion.css class alone, for an icon that takes its colour from a chip. */
  statusMotion: ComputedRef<string>;
  cardClass: ComputedRef<string>;
}

/** The one status vocabulary of every tool card (the reference's tool row, Chat Panel.dc.html m.isTool). */
export function useToolCardStatus(status: MaybeRefOrGetter<ToolStatus>): ToolCardStatus {
  return {
    statusIcon: computed(() => iconFor(toValue(status))),
    statusClass: computed(() => [textClassFor(toValue(status)), motionFor(toValue(status))].filter(Boolean).join(" ")),
    statusMotion: computed(() => motionFor(toValue(status))),
    cardClass: computed(() => borderClassFor(toValue(status))),
  };
}
