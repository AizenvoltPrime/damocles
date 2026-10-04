<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Download, ExternalLink, Mic } from "lucide-vue-next";
import OverlayShell from "./OverlayShell.vue";
import type { ModelUpgradeInfo } from "@/stores/useVoiceJarvisStore";

const props = defineProps<{
  upgrades: ModelUpgradeInfo[];
}>();

const emit = defineEmits<{
  (e: "accept", modelIds: string[]): void;
  (e: "dismiss"): void;
  (e: "openLicense", url: string): void;
}>();

const { t } = useI18n();

const totalBytes = computed<number>(() => props.upgrades.reduce((acc, u) => acc + u.bytesDelta, 0));

const subtitle = computed<string>(() =>
  props.upgrades.length === 1
    ? t("voiceModelUpgrade.subtitleOne")
    : t("voiceModelUpgrade.subtitleMany", { count: props.upgrades.length }),
);

function formatGB(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  return `${(bytes / 1_000_000).toFixed(0)} MB`;
}

function handleAccept(): void {
  emit("accept", props.upgrades.map((u) => u.modelId));
}

function handleDismiss(): void {
  emit("dismiss");
}

function handleOpenLicense(url: string): void {
  emit("openLicense", url);
}
</script>

<template>
  <OverlayShell
    :title="t('voiceModelUpgrade.title')"
    :subtitle="subtitle"
    :icon="Mic"
    max-width="40rem"
    data-testid="voice-model-upgrade"
    @close="handleDismiss"
  >
    <div class="flex flex-col gap-3 px-4.5 pt-4 pb-5">
      <div
        v-for="u in upgrades"
        :key="u.modelId"
        class="flex flex-col gap-1 rounded-10 border border-(--d-border) bg-(--d-card) px-3 py-2.5"
      >
        <div class="flex items-center gap-2 text-12.5">
          <span class="min-w-0 flex-1 truncate font-medium">{{ u.modelId }}</span>
          <span class="flex-none font-mono text-xs text-(--d-muted) tabular-nums">v{{ u.installedVersion }} → v{{ u.newVersion }}</span>
        </div>
        <p class="text-xs text-pretty text-(--d-muted)">
          {{ u.description }}
        </p>
        <div class="flex items-center gap-2 text-11 text-(--d-faint)">
          <span class="font-mono">{{ formatGB(u.bytesDelta) }}</span>
          <span class="rounded-5 bg-(--d-hover) px-1.5 text-10.5 text-(--d-muted)">{{ u.license }}</span>
          <span class="flex-1" />
          <button
            v-if="u.licenseUrl"
            type="button"
            class="flex items-center gap-1 text-xs text-(--d-accent) hover:underline"
            @click="handleOpenLicense(u.licenseUrl)"
          >
            <ExternalLink
              class="size-3"
              aria-hidden="true"
            />
            {{ t("voiceModelUpgrade.reviewLicense") }}
          </button>
        </div>
      </div>
      <p class="text-xs text-pretty text-(--d-faint)">
        {{ t("voiceModelUpgrade.rollbackNote") }}
      </p>
    </div>

    <template #footer>
      <footer class="flex flex-none items-center gap-2 border-t border-(--d-border) bg-(--d-panel) px-3.5 py-2.5">
        <span class="flex-1 text-11.5 text-(--d-faint)">{{ t("voiceModelUpgrade.totalDownloadSize") }} <span class="font-mono text-(--d-muted)">{{ formatGB(totalBytes) }}</span></span>
        <button
          type="button"
          class="d-press flex h-7.5 items-center rounded-9 border border-(--d-border2) px-3 text-12.5 transition-colors hover:bg-(--d-hover)"
          @click="handleDismiss"
        >
          {{ t("voiceModelUpgrade.dismiss") }}
        </button>
        <button
          type="button"
          class="d-press flex h-7.5 items-center gap-1.5 rounded-9 bg-(--d-accent) px-3.5 text-12.5 font-semibold text-(--d-on-accent) transition-[filter] hover:brightness-110"
          @click="handleAccept"
        >
          <Download
            class="size-3.25"
            aria-hidden="true"
          />
          {{ t("voiceModelUpgrade.accept") }}
        </button>
      </footer>
    </template>
  </OverlayShell>
</template>
