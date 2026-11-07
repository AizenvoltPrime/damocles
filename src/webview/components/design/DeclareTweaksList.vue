<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { Lock } from 'lucide-vue-next';
import type { DeclareTweaksDetails, TweakControl } from '@shared/types/design';
import { isTweakColor } from '@shared/design-tweaks';

// DeclareTweaks' result: each control with its property, its token stops (swatches for colors) and any lock, as declared.
defineProps<{ details: DeclareTweaksDetails }>();
const { t } = useI18n();

function stopName(control: TweakControl, token: string): string {
  return token.startsWith(`${control.property}-`) && token.length > control.property.length + 1 ? token.slice(control.property.length + 1) : token.replace(/^--/, '');
}
</script>

<template>
  <ul
    class="@container flex flex-col gap-2 border-t border-(--d-border) px-3 py-2 text-xs"
    data-testid="design-declared-tweaks"
  >
    <li
      v-for="control in details.controls"
      :key="control.id"
      data-testid="design-declared-tweak"
      :data-tweak="control.id"
      :data-locked="control.locked ? 'true' : undefined"
      class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
    >
      <span class="min-w-0 font-medium text-(--d-text)">{{ control.label }}</span>
      <span
        dir="ltr"
        class="font-mono text-11 text-(--d-faint-text)"
      >{{ control.property }}</span>
      <span
        v-if="control.locked"
        data-testid="design-declared-tweak-lock"
        :title="t('design.tweaks.lockedTitle', { id: control.locked.decisionId, token: control.locked.value })"
        class="d-tone-design inline-flex h-4.5 items-center gap-1 rounded-full border border-(--tone)/30 bg-(--tone)/12 px-1.5 font-mono text-10.5"
      >
        <Lock
          aria-hidden="true"
          class="size-2.75"
        /><span class="sr-only">{{ t('design.tweaks.locked') }}</span>{{ control.locked.decisionId }}
      </span>
      <ul
        :aria-label="t('design.tweaks.stops', { label: control.label })"
        class="flex basis-full flex-wrap items-center gap-1 @min-[28rem]:ms-auto @min-[28rem]:basis-auto"
      >
        <li
          v-for="stop in control.stops"
          :key="stop.token"
          :title="`${stop.token} · ${stop.value}`"
          data-testid="design-declared-tweak-stop"
          :data-token="stop.token"
          :data-locked-value="control.locked?.value === stop.token ? 'true' : undefined"
          class="inline-flex h-5 items-center gap-1 rounded-full border px-1.5 font-mono text-10.5"
          :class="control.locked?.value === stop.token ? 'border-(--d-design) text-(--d-text)' : 'border-(--d-border) text-(--d-muted)'"
        >
          <!-- A value core classed as a color still binds only when it reads as one, so no other CSS value reaches the style. -->
          <span
            v-if="control.kind === 'swatch' && isTweakColor(stop.value)"
            aria-hidden="true"
            data-testid="design-declared-tweak-swatch"
            class="size-2.5 flex-none rounded-full shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--d-text)_18%,transparent)]"
            :style="{ background: stop.value }"
          />
          <span dir="ltr">{{ stopName(control, stop.token) }}</span>
          <span class="sr-only">{{ `, ${stop.value}` }}</span>
        </li>
      </ul>
    </li>
  </ul>
</template>
