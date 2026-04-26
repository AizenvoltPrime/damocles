<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { IconExternalLink, IconMicrophone } from "@/components/icons";
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
  if (entry.status === "error") return "text-destructive";
  if (entry.status === "done") return "text-emerald-500";
  if (entry.status === "verifying") return "text-amber-500";
  return "text-primary";
}

function handleCancel(): void {
  emit("cancel");
}

function handleOpenLicense(url: string): void {
  emit("openLicense", url);
}
</script>

<template>
  <OverlayShell
    :title="t('voiceModelDownload.title')"
    :subtitle="subtitle"
    :icon="IconMicrophone"
    icon-class="text-primary"
    @close="handleCancel"
  >
    <div class="p-6 max-w-3xl mx-auto space-y-4">
      <div class="space-y-3">
        <Card v-for="{ id, entry } in entries" :key="id">
          <CardContent class="pt-4 space-y-2">
            <div class="flex items-baseline justify-between gap-2">
              <div class="flex items-baseline gap-2 min-w-0">
                <span class="text-sm font-medium text-foreground truncate">
                  {{ entry.displayName ?? id }}
                </span>
                <span v-if="entry.licenseName" class="text-xs text-muted-foreground shrink-0">
                  {{ entry.licenseName }}
                </span>
              </div>
              <span class="text-xs shrink-0 tabular-nums" :class="statusColorClass(entry)">
                {{ statusLabel(entry) }} · {{ percentOf(entry) }}%
              </span>
            </div>

            <Progress
              :model-value="percentOf(entry)"
              class="h-1.5"
            />

            <div class="flex items-center justify-between text-xs">
              <span class="font-medium tabular-nums text-foreground">
                <template v-if="entry.status === 'downloading' && throughputBps[id] !== undefined">
                  {{ formatBps(throughputBps[id]!) }}
                </template>
                <template v-else>&nbsp;</template>
              </span>
              <span class="text-muted-foreground tabular-nums">
                {{ formatGB(entry.bytesReceived) }} / {{ formatGB(entry.bytesTotal) }}
              </span>
            </div>

            <p
              v-if="entry.status === 'error' && entry.message"
              class="text-xs text-destructive"
              role="alert"
            >
              {{ entry.message }}
            </p>

            <div v-if="entry.licenseUrl" class="pt-1">
              <Button
                variant="link"
                size="sm"
                class="h-auto p-0 text-xs gap-1"
                @click="handleOpenLicense(entry.licenseUrl!)"
              >
                <IconExternalLink :size="12" />
                {{ t("voiceModelDownload.openLicense") }}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <div v-if="hasLicenseGated" class="text-xs text-muted-foreground">
        {{ t("voiceModelDownload.licenseGatedNote") }}
      </div>

      <div class="flex justify-end pt-2">
        <Button
          variant="outline"
          :disabled="isAllDone"
          @click="handleCancel"
        >
          {{ t("voiceModelDownload.cancel") }}
        </Button>
      </div>
    </div>
  </OverlayShell>
</template>
