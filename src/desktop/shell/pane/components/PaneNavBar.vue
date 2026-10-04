<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ArrowLeft, ArrowRight, Bug, CircleAlert, ExternalLink, MousePointerClick, RotateCw } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { MAX_PANE_URL_LENGTH, type DamoclesPaneApi, type PanePage } from '../../../preload/pane-channels';
import { isSendableAddress, isWebUrl } from '../page-ids';

const props = defineProps<{
  api: DamoclesPaneApi;
  page: PanePage | undefined;
}>();
const { t } = useI18n();

const address = ref('');
const editing = ref(false);
const refused = ref(false);
// A sent address stays in the field until the page leaves `fromUrl`, or a load starts and ends without leaving it.
const pending = ref<{ pageId: string; fromUrl: string; sawLoading: boolean } | null>(null);

// A blank page shows the placeholder, ready for an address.
function shownAddress(): string {
  const url = props.page?.url ?? '';
  return url === 'about:blank' ? '' : url;
}

// The field shows the page's address except while the user is typing over it.
watch(() => props.page?.id, () => {
  editing.value = false;
  refused.value = false;
});
watch(() => [props.page?.id, props.page?.url, props.page?.loading] as const, ([id, url, loading]) => {
  const sent = pending.value;
  if (sent) {
    const settledInPlace = sent.sawLoading && loading !== true;
    if (id === sent.pageId && url === sent.fromUrl && !settledInPlace) {
      if (loading === true) sent.sawLoading = true;
      return;
    }
    pending.value = null;
  }
  if (!editing.value) address.value = shownAddress();
}, { immediate: true });

const canOpenExternally = computed(() => props.page !== undefined && isWebUrl(props.page.url));

async function navigate(): Promise<void> {
  const page = props.page;
  const typed = address.value.trim();
  if (!page || typed === '') return;
  const accepted = typed.length <= MAX_PANE_URL_LENGTH && isSendableAddress(typed) && await props.api.navigate(page.id, typed);
  refused.value = !accepted;
  if (!accepted) return;
  editing.value = false;
  if (props.page?.id === page.id) pending.value = { pageId: page.id, fromUrl: page.url, sawLoading: false };
}

function onAddressKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault();
    void navigate();
    return;
  }
  // Escape reverts a pending edit first; with nothing to revert it reaches the pane, which may dismiss the overlay.
  if (event.key === 'Escape' && (editing.value || refused.value || pending.value)) {
    event.stopPropagation();
    editing.value = false;
    refused.value = false;
    pending.value = null;
    address.value = shownAddress();
  }
}

function onInput(): void {
  editing.value = true;
  refused.value = false;
}

const ICON_BUTTON = 'size-7 shrink-0 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground active:bg-muted-foreground/20 focus-visible:ring-offset-0';
</script>

<template>
  <div class="flex h-full min-w-0 items-center gap-0.5 px-1.5">
    <Button
      variant="ghost"
      size="icon-sm"
      :class="ICON_BUTTON"
      :disabled="!page?.canGoBack"
      :aria-label="t('pane.back')"
      :title="t('pane.back')"
      @click="page && api.goBack(page.id)"
    >
      <ArrowLeft aria-hidden="true" />
    </Button>
    <Button
      variant="ghost"
      size="icon-sm"
      :class="ICON_BUTTON"
      :disabled="!page?.canGoForward"
      :aria-label="t('pane.forward')"
      :title="t('pane.forward')"
      @click="page && api.goForward(page.id)"
    >
      <ArrowRight aria-hidden="true" />
    </Button>
    <Button
      variant="ghost"
      size="icon-sm"
      :class="ICON_BUTTON"
      :disabled="!page"
      :aria-label="t('pane.reload')"
      :title="t('pane.reload')"
      @click="page && api.reload(page.id)"
    >
      <RotateCw
        :class="page?.loading && 'd-spinning'"
        aria-hidden="true"
      />
    </Button>
    <div class="relative mx-1 flex min-w-0 flex-1">
      <input
        id="pane-address"
        v-model="address"
        type="text"
        inputmode="url"
        spellcheck="false"
        autocomplete="off"
        :disabled="!page"
        :placeholder="t('pane.addressPlaceholder')"
        :aria-label="t('pane.address')"
        :aria-invalid="refused || undefined"
        :aria-describedby="refused ? 'pane-address-error' : undefined"
        :title="refused ? t('pane.addressRefused') : undefined"
        :class="cn(
          'h-7 w-full min-w-0 rounded-md border bg-input px-2.5 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
          refused ? 'border-error pr-7 focus:border-error' : 'border-border hover:border-muted-foreground/40 focus:border-ring',
        )"
        @focus="($event.target as HTMLInputElement).select()"
        @input="onInput"
        @keydown="onAddressKeydown"
      >
      <CircleAlert
        v-if="refused"
        class="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-error"
        aria-hidden="true"
      />
      <span
        id="pane-address-error"
        role="status"
        class="sr-only"
      >{{ refused ? t('pane.addressRefused') : '' }}</span>
    </div>
    <Button
      variant="ghost"
      size="icon-sm"
      :class="ICON_BUTTON"
      :disabled="!canOpenExternally"
      :aria-label="t('pane.openExternal')"
      :title="canOpenExternally ? t('pane.openExternal') : t('pane.openExternalUnavailable')"
      @click="page && api.openExternal(page.id)"
    >
      <ExternalLink aria-hidden="true" />
    </Button>
    <Button
      variant="ghost"
      size="icon-sm"
      :class="cn(ICON_BUTTON, page?.picking && 'bg-muted text-foreground')"
      :disabled="!page"
      :aria-label="t('pane.pickElement')"
      :aria-pressed="page?.picking ?? false"
      :title="t('pane.pickElement')"
      @click="page && api.pickElement(page.id)"
    >
      <MousePointerClick aria-hidden="true" />
    </Button>
    <Button
      variant="ghost"
      size="icon-sm"
      :class="ICON_BUTTON"
      :disabled="!page"
      :aria-label="t('pane.devTools')"
      :title="t('pane.devTools')"
      @click="page && api.openDevTools(page.id)"
    >
      <Bug aria-hidden="true" />
    </Button>
  </div>
</template>
