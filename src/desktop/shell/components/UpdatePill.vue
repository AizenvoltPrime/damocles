<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import { ArrowDownToLine, ExternalLink, RotateCw } from 'lucide-vue-next';
import type { DamoclesShellApi, ShellPlatform } from '../../preload/shell-channels';
import type { OverlayIcon, OverlayMenuItem } from '../../preload/overlay-channels';
import { isUpdateAction, type UpdateSnapshot } from '../../preload/updates';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { pillMenu, pillView, type PillMenuItem, type PillView } from '../update-view';

const props = defineProps<{ api: DamoclesShellApi; platform: ShellPlatform }>();
const { t } = useI18n();

const snapshot = shallowRef<UpdateSnapshot | null>(null);
const pill = computed(() => (snapshot.value ? pillView(snapshot.value.state) : null));
const menuOpen = ref(false);

const ICONS: Readonly<Record<PillView['kind'], Component>> = {
  downloading: ArrowDownToLine,
  ready: RotateCw,
  restarting: RotateCw,
  available: ExternalLink,
};
const MENU_ICONS: Readonly<Record<PillMenuItem['action'], OverlayIcon>> = {
  restart: 'rotate-cw',
  releaseNotes: 'file-text',
  showLog: 'scroll-text',
};

const text = computed(() => {
  const view = pill.value;
  if (!view) return '';
  return view.kind === 'downloading' ? t('update.downloading', { percent: view.percent }) : t(`update.${view.kind}`);
});
const title = computed(() => (pill.value ? t(`update.${pill.value.kind}Title`, { version: pill.value.version }) : ''));
// The fill grows with the download and stays full once the update is ready, as the pill's background.
const fill = computed(() => (pill.value?.kind === 'downloading' ? pill.value.percent : 100));
const hasMenu = computed(() => pill.value !== null && pill.value.kind !== 'available');

// The switch to ready draws the eye once; nothing plays for the state the page loads with, or for a cancelled restart.
const attention = ref(0);
watch(() => pill.value?.kind, (kind, previous) => {
  if (kind === 'ready' && previous !== undefined && previous !== 'ready' && previous !== 'restarting') attention.value++;
});

async function activate(event: MouseEvent): Promise<void> {
  const view = pill.value;
  const rect = (event.currentTarget as Element | null)?.getBoundingClientRect();
  if (!view || !rect || menuOpen.value) return;
  if (view.kind === 'available') {
    await props.api.runUpdateAction('releasePage');
    return;
  }
  const items: OverlayMenuItem[] = pillMenu(view).map((item) => ({
    kind: 'item',
    id: item.action,
    label: t(`update.${item.action}`),
    icon: MENU_ICONS[item.action],
    ...(item.disabled ? { disabled: true } : {}),
  }));
  menuOpen.value = true;
  try {
    const answer = await props.api.requestOverlay({
      kind: 'menu',
      label: t('update.menuLabel'),
      anchor: { x: Math.max(0, rect.left), y: Math.max(0, rect.top), width: rect.width, height: rect.height },
      items,
    });
    if (answer.kind === 'menu' && isUpdateAction(answer.itemId)) await props.api.runUpdateAction(answer.itemId);
  } finally {
    menuOpen.value = false;
  }
}

let stop: (() => void) | undefined;
onMounted(async () => {
  // Subscribed before the first read, so a change between the two is not lost; a push is always the newer state.
  stop = props.api.onUpdate((next) => {
    snapshot.value = next;
  });
  const first = await props.api.getUpdate();
  if (!snapshot.value) snapshot.value = first;
});
onBeforeUnmount(() => stop?.());
</script>

<template>
  <Transition name="update-pill">
    <Button
      v-if="pill"
      type="button"
      variant="outline"
      size="sm"
      data-testid="update-pill"
      :data-state="pill.kind"
      :data-platform="platform"
      class="title-bar-control update-pill d-press mr-1.5 flex h-6 shrink-0 rounded-full bg-transparent px-2.5 text-11.5 font-medium tabular-nums hover:border-(--d-accent) hover:bg-transparent [&_svg]:size-3.25"
      :class="pill.kind === 'downloading' ? 'border-(--d-border2) text-(--d-text) hover:text-(--d-text)' : 'border-(--d-accent)/45 text-(--d-accent-text) hover:text-(--d-accent-text)'"
      :title="title"
      :aria-haspopup="hasMenu ? 'menu' : undefined"
      :aria-expanded="hasMenu ? menuOpen : undefined"
      @click="activate"
    >
      <span
        aria-hidden="true"
        class="update-pill-clip"
      >
        <Progress
          data-testid="update-pill-fill"
          class="update-pill-fill"
          :model-value="fill"
        />
        <span
          v-if="attention > 0"
          :key="attention"
          class="update-pill-shine"
        />
      </span>
      <span
        v-if="attention > 0"
        :key="attention"
        aria-hidden="true"
        class="update-pill-ring"
      />
      <Transition
        name="update-swap"
        mode="out-in"
      >
        <span
          :key="pill.kind"
          class="relative flex items-center gap-1.5"
        >
          <component
            :is="ICONS[pill.kind]"
            aria-hidden="true"
            class="size-3.25 shrink-0"
            :class="pill.kind === 'restarting' ? 'd-spinning' : ''"
          />
          <span data-testid="update-pill-label">{{ text }}</span>
        </span>
      </Transition>
    </Button>
  </Transition>
</template>
