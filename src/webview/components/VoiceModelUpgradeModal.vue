<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { IconExternalLink, IconMicrophone } from "@/components/icons";
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
    :icon="IconMicrophone"
    icon-class="text-primary"
    @close="handleDismiss"
  >
    <div class="p-6 max-w-3xl mx-auto space-y-4">
      <Card>
        <CardHeader class="pb-3">
          <CardTitle class="text-sm flex items-center justify-between">
            <span>{{ t("voiceModelUpgrade.totalDownloadSize") }}</span>
            <span class="text-muted-foreground font-normal">{{ formatGB(totalBytes) }}</span>
          </CardTitle>
        </CardHeader>
        <CardContent class="text-xs text-muted-foreground">
          {{ t("voiceModelUpgrade.rollbackNote") }}
        </CardContent>
      </Card>

      <div class="space-y-3">
        <Card v-for="u in upgrades" :key="u.modelId">
          <CardContent class="pt-4 space-y-2">
            <div class="flex items-baseline justify-between gap-2">
              <div class="flex flex-col min-w-0">
                <span class="text-sm font-medium text-foreground truncate">{{ u.modelId }}</span>
                <span class="text-xs text-muted-foreground">{{ u.description }}</span>
              </div>
              <span class="text-xs text-muted-foreground tabular-nums shrink-0">
                v{{ u.installedVersion }} → v{{ u.newVersion }}
              </span>
            </div>
            <div class="flex items-center justify-between text-xs text-muted-foreground">
              <span>{{ formatGB(u.bytesDelta) }}</span>
              <span>{{ u.license }}</span>
            </div>
            <div v-if="u.licenseUrl">
              <Button
                variant="link"
                size="sm"
                class="h-auto p-0 text-xs gap-1"
                @click="handleOpenLicense(u.licenseUrl)"
              >
                <IconExternalLink :size="12" />
                {{ t("voiceModelUpgrade.reviewLicense") }}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <div class="flex justify-end gap-2 pt-2">
        <Button
          variant="outline"
          @click="handleDismiss"
        >
          {{ t("voiceModelUpgrade.dismiss") }}
        </Button>
        <Button
          variant="default"
          @click="handleAccept"
        >
          {{ t("voiceModelUpgrade.accept") }}
        </Button>
      </div>
    </div>
  </OverlayShell>
</template>
