<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { AlertTriangle, Ban, Check, Download, Info } from 'lucide-vue-next';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import SettingButton from '@/components/settings/controls/SettingButton.vue';
import { useLocalizedText } from '@/composables/useLocalizedText';
import { IsolatedText } from '@/components/isolated-text';
import { isolated } from '@shared/bidi-isolate';
import type { ThemeExportFont, ThemeExportPlan } from '@shared/themes/install';

// Export…: each font the theme uses with its license and what Export does with it, before main's save dialog. Free licenses
// pack after this one confirm, others after the warning; a font whose license forbids embedding stops the export.
const props = defineProps<{
  plan: ThemeExportPlan | undefined;
  busy: boolean;
  // why the export did not land, in the UI's language
  failure: string | undefined;
}>();
const emit = defineEmits<{ (e: 'save'): void; (e: 'close'): void }>();

const { t } = useI18n();
const { rt } = useLocalizedText();

const license = (font: ThemeExportFont): string => font.spdx ?? t('settingsHost.themes.export.noLicense');
const fonts = computed(() => (props.plan?.fonts ?? []).map((font) => ({
  key: `${font.role}-${font.family}`,
  verdict: font.verdict,
  name: t('settingsHost.themes.export.font', { family: isolated(font.family), role: t(`settingsHost.themes.export.role.${font.role}`), license: license(font) }),
  note: font.verdict === 'refused' && font.refusal ? rt(font.refusal) : t(`settingsHost.themes.export.verdict.${font.verdict}`),
})));
const refused = computed(() => (props.plan?.fonts ?? []).filter((font) => font.verdict === 'refused').map((font) => font.family));
const warned = computed(() => fonts.value.some((font) => font.verdict === 'warn'));
const ICONS = { confirm: Check, warn: AlertTriangle, refused: Ban, nameOnly: Info } as const;
const TONES = { confirm: 'text-(--d-success-text)', warn: 'text-(--d-warning-text)', refused: 'text-(--d-danger-text)', nameOnly: 'text-(--d-muted)' } as const;
</script>

<template>
  <Dialog
    :open="plan !== undefined"
    @update:open="(open: boolean) => { if (!open && !busy) emit('close') }"
  >
    <DialogContent
      class="max-w-120 gap-3"
      data-testid="theme-export-dialog"
    >
      <DialogTitle class="flex items-center gap-2 text-13">
        <Download
          class="size-3.5 text-(--d-muted)"
          aria-hidden="true"
        /><span><IsolatedText :text="t('settingsHost.themes.export.title', { name: isolated(plan?.name ?? '') })" /></span>
      </DialogTitle>
      <DialogDescription class="text-12 text-pretty text-(--d-muted)">
        {{ t('settingsHost.themes.export.body') }}
      </DialogDescription>
      <ul
        class="flex flex-col divide-y divide-(--d-border) rounded-8 border border-(--d-border)"
        :aria-label="t('settingsHost.themes.export.fonts')"
        data-testid="theme-export-fonts"
      >
        <li
          v-for="font in fonts"
          :key="font.key"
          class="flex items-start gap-2 px-2.5 py-2 text-12"
          :data-verdict="font.verdict"
        >
          <component
            :is="ICONS[font.verdict]"
            class="mt-0.5 size-3.5 flex-none"
            :class="TONES[font.verdict]"
            aria-hidden="true"
          />
          <span class="flex min-w-0 flex-col">
            <span class="font-medium wrap-anywhere"><IsolatedText :text="font.name" /></span>
            <span
              class="text-pretty"
              :class="font.verdict === 'refused' || font.verdict === 'warn' ? TONES[font.verdict] : 'text-(--d-muted)'"
            >{{ font.note }}</span>
          </span>
        </li>
      </ul>
      <p
        v-if="refused.length > 0"
        class="sm-feedback sm-feedback-error"
        role="alert"
        data-testid="theme-export-refused"
      >
        <IsolatedText :text="t('settingsHost.themes.export.refused', { fonts: refused.map(isolated).join(', ') }, refused.length)" />
      </p>
      <p
        v-else-if="warned"
        class="text-11 text-pretty text-(--d-warning-text)"
        data-testid="theme-export-warning"
      >
        {{ t('settingsHost.themes.export.responsibility') }}
      </p>
      <p
        v-if="failure"
        class="sm-feedback sm-feedback-error"
        role="alert"
        data-testid="theme-export-error"
      >
        {{ failure }}
      </p>
      <div class="mt-1 flex justify-end gap-2">
        <SettingButton
          :disabled="busy"
          @click="emit('close')"
        >
          {{ t('settingsHost.themes.cancel') }}
        </SettingButton>
        <SettingButton
          variant="primary"
          :disabled="busy || refused.length > 0"
          data-testid="theme-export-save"
          @click="emit('save')"
        >
          {{ t('settingsHost.themes.export.save') }}
        </SettingButton>
      </div>
    </DialogContent>
  </Dialog>
</template>
