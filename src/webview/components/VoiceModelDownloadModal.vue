<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ExternalLink, Mic } from "lucide-vue-next";
import OverlayShell from "./OverlayShell.vue";

const { t } = useI18n();

export type ModelDownloadStatus = "downloading" | "verifying" | "done" | "error";

export interface ModelDownloadEntry {
  bytesReceived: number;
  bytesTotal: number;
  status: ModelDownloadStatus;
  message?: string;
  licenseUrl?: string;
  licenseName?: string;
  displayName?: string;
}

const props = defineProps<{
  downloads: Record<string, ModelDownloadEntry>;
}>();

const emit = defineEmits<{
  /** Closing hides the modal; the download keeps running. */
  (e: "hide"): void;
  (e: "cancel"): void;
  (e: "openLicense", url: string): void;
}>();

interface ThroughputSample {
  bytes: number;
  timestamp: number;
}

const throughputSamples = ref<Record<string, ThroughputSample>>({});
const throughputBps = ref<Record<string, number>>({});

watch(
  () => props.downloads,
  (next) => {
    const now = performance.now();
    for (const [modelId, entry] of Object.entries(next)) {
      const prev = throughputSamples.value[modelId];
      if (prev !== undefined) {
        const dtSec = (now - prev.timestamp) / 1000;
        const dBytes = entry.bytesReceived - prev.bytes;
        if (dtSec > 0.1 && dBytes >= 0) {
          throughputBps.value[modelId] = dBytes / dtSec;
        }
      }
      throughputSamples.value[modelId] = { bytes: entry.bytesReceived, timestamp: now };
    }
  },
  { deep: true, immediate: true },
);

const entries = computed<{ id: string; entry: ModelDownloadEntry }[]>(() =>
  Object.entries(props.downloads).map(([id, entry]) => ({ id, entry })),
);

const hasLicenseGated = computed<boolean>(() =>
  entries.value.some(({ entry }) => entry.licenseUrl !== undefined && entry.licenseUrl.length > 0),
);

const isAllDone = computed<boolean>(() =>
  entries.value.length > 0 && entries.value.every(({ entry }) => entry.status === "done"),
);

const subtitle = computed<string>(() => {
  if (isAllDone.value) return t("voiceModelDownload.allComplete");
  const downloading = entries.value.filter(({ entry }) => entry.status === "downloading").length;
  const verifying = entries.value.filter(({ entry }) => entry.status === "verifying").length;
  if (verifying > 0 && downloading === 0) return t("voiceModelDownload.verifying");
  if (entries.value.length === 1) return t("voiceModelDownload.downloadingOne");
  return t("voiceModelDownload.downloadingMany", { count: entries.value.length });
});

function formatGB(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

function formatBps(bps: number): string {
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} MB/s`;
  if (bps >= 1_000) return `${(bps / 1_000).toFixed(0)} KB/s`;
  return `${Math.round(bps)} B/s`;
}

function percentOf(entry: ModelDownloadEntry): number {
  if (entry.bytesTotal <= 0) return 0;
  return Math.min(100, Math.round((entry.bytesReceived / entry.bytesTotal) * 100));
}

function statusLabel(entry: ModelDownloadEntry): string {
  if (entry.status === "downloading") return t("voiceModelDownload.statusDownloading");
  if (entry.status === "verifying") return t("voiceModelDownload.statusVerifying");
  if (entry.status === "done") return t("voiceModelDownload.statusDone");
  return t("voiceModelDownload.statusError");
}

function statusColorClass(entry: ModelDownloadEntry): string {
  if (entry.status === "error") return "text-(--d-danger)";
  if (entry.status === "done") return "text-(--d-success)";
  if (entry.status === "verifying") return "text-(--d-warning)";
  return "text-(--d-accent)";
}

function handleOpenLicense(url: string): void {
  emit("openLicense", url);
}
</script>

<template>
  <OverlayShell
    :title="t('voiceModelDownload.title')"
    :subtitle="subtitle"
    :icon="Mic"
    max-width="40rem"
    data-testid="voice-model-download"
    @close="emit('hide')"
  >
    <div class="flex flex-col gap-3 px-4.5 pt-4 pb-5">
      <div
        v-for="{ id, entry } in entries"
        :key="id"
        class="flex flex-col gap-1.5 rounded-10 border border-(--d-border) bg-(--d-card) px-3 py-2.5"
      >
        <div class="flex items-center gap-2 text-12.5">
          <span class="min-w-0 flex-1 truncate font-medium">{{ entry.displayName ?? id }}</span>
          <span
            v-if="entry.licenseName"
            class="flex-none rounded-5 bg-(--d-hover) px-1.5 text-10.5 text-(--d-muted)"
          >{{ entry.licenseName }}</span>
          <span
            class="flex-none font-mono text-xs tabular-nums"
            :class="statusColorClass(entry)"
          >{{ statusLabel(entry) }} · {{ percentOf(entry) }}%</span>
        </div>
        <div
          class="h-1.5 overflow-hidden rounded-full bg-(--d-hover)"
          role="progressbar"
          :aria-label="entry.displayName ?? id"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="percentOf(entry)"
        >
          <div
            class="h-full origin-left rounded-full transition-transform duration-300 ease-out rtl:origin-right"
            :class="entry.status === 'error' ? 'bg-(--d-danger)' : entry.status === 'done' ? 'bg-(--d-success)' : 'bg-(--d-accent)'"
            :style="{ transform: `scaleX(${percentOf(entry) / 100})` }"
          />
        </div>
        <div class="flex items-center justify-between font-mono text-11 text-(--d-faint) tabular-nums">
          <span>{{ entry.status === 'downloading' && throughputBps[id] !== undefined ? formatBps(throughputBps[id]!) : '' }}</span>
          <span>{{ formatGB(entry.bytesReceived) }} / {{ formatGB(entry.bytesTotal) }}</span>
        </div>
        <p
          v-if="entry.status === 'error' && entry.message"
          class="text-xs text-(--d-danger)"
          role="alert"
        >
          {{ entry.message }}
        </p>
        <button
          v-if="entry.licenseUrl"
          type="button"
          class="flex items-center gap-1 self-start text-xs text-(--d-accent) hover:underline"
          @click="handleOpenLicense(entry.licenseUrl!)"
        >
          <ExternalLink
            class="size-3"
            aria-hidden="true"
          />
          {{ t("voiceModelDownload.openLicense") }}
        </button>
      </div>
    </div>

    <template #footer>
      <footer class="flex flex-none items-center gap-2 border-t border-(--d-border) bg-(--d-panel) px-3.5 py-2.5">
        <span class="flex-1 text-11.5 text-pretty text-(--d-faint)">{{ hasLicenseGated ? t("voiceModelDownload.licenseGatedNote") : '' }}</span>
        <button
          type="button"
          class="d-press flex h-7.5 items-center rounded-9 border border-(--d-border2) px-3 text-12.5 transition-colors enabled:hover:bg-(--d-hover) disabled:opacity-40"
          :disabled="isAllDone"
          data-testid="voice-model-download-cancel"
          @click="emit('cancel')"
        >
          {{ t("voiceModelDownload.cancel") }}
        </button>
      </footer>
    </template>
  </OverlayShell>
</template>
