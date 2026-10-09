<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DamoclesShellApi, ShellWindowState } from '../../preload/shell-channels';

const props = defineProps<{ api: DamoclesShellApi; windowState: ShellWindowState }>();
const { t } = useI18n();

const maximizeLabel = computed(() => (props.windowState === 'maximized' ? t('titleBar.restore') : t('titleBar.maximize')));
</script>

<!-- Out of the Tab order, as native window controls are; Alt+F4 and Win+arrows stay the keyboard path. -->
<template>
  <div
    data-testid="window-controls"
    class="flex h-full shrink-0 items-stretch"
  >
    <button
      type="button"
      tabindex="-1"
      data-testid="window-minimize"
      class="title-bar-control flex w-11.5 items-center justify-center text-(--d-muted) transition-colors duration-100 hover:bg-(--d-hover) hover:text-(--d-text) active:bg-(--d-border2)"
      :aria-label="t('titleBar.minimize')"
      :title="t('titleBar.minimize')"
      @click="api.windowControl('minimize')"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 10 10"
        class="size-2.5 fill-none stroke-current"
        shape-rendering="crispEdges"
      >
        <path d="M0 5.5h10" />
      </svg>
    </button>
    <button
      type="button"
      tabindex="-1"
      data-testid="window-maximize"
      class="title-bar-control flex w-11.5 items-center justify-center text-(--d-muted) transition-colors duration-100 hover:bg-(--d-hover) hover:text-(--d-text) active:bg-(--d-border2)"
      :aria-label="maximizeLabel"
      :title="maximizeLabel"
      @click="api.windowControl('toggleMaximize')"
    >
      <svg
        v-if="windowState === 'maximized'"
        aria-hidden="true"
        viewBox="0 0 10 10"
        class="size-2.5 fill-none stroke-current"
        shape-rendering="crispEdges"
      >
        <path d="M2.5 2.5V.5h7v7h-2" />
        <rect
          x=".5"
          y="2.5"
          width="7"
          height="7"
        />
      </svg>
      <svg
        v-else
        aria-hidden="true"
        viewBox="0 0 10 10"
        class="size-2.5 fill-none stroke-current"
        shape-rendering="crispEdges"
      >
        <rect
          x=".5"
          y=".5"
          width="9"
          height="9"
        />
      </svg>
    </button>
    <button
      type="button"
      tabindex="-1"
      data-testid="window-close"
      class="title-bar-control flex w-11.5 items-center justify-center text-(--d-muted) transition-colors duration-100 hover:bg-(--d-danger) hover:text-(--d-on-danger) active:opacity-80"
      :aria-label="t('titleBar.close')"
      :title="t('titleBar.close')"
      @click="api.windowControl('close')"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 10 10"
        class="size-2.5 fill-none stroke-current"
      >
        <path d="M.5.5l9 9M9.5.5l-9 9" />
      </svg>
    </button>
  </div>
</template>
