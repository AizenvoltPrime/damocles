<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import type { ElicitationRequest } from '@shared/types/elicitation';
import { Check, ExternalLink, Plug } from 'lucide-vue-next';
import { useElicitationStore } from '@/stores/useElicitationStore';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useAttentionCard } from '@/composables/useAttention';
import { useDockCardVisibility } from '@/composables/useDockCardVisibility';
import TrustedCheckingNote from './TrustedCheckingNote.vue';

const store = useElicitationStore();
const { postMessage } = usePlatformBridge();

const currentElicitation = computed((): ElicitationRequest | undefined =>
  store.pendingElicitations[0]
);

const formValues = ref<Record<string, unknown>>({});
const cardRef = ref<HTMLElement | null>(null);
useAttentionCard('input', cardRef);
const { isVisible, explain } = useDockCardVisibility(cardRef);

watch(() => currentElicitation.value?.elicitationId, () => {
  formValues.value = {};
});

const schemaProperties = computed(() => {
  const schema = currentElicitation.value?.requestedSchema;
  if (!schema || typeof schema !== 'object') return [];
  const props = (schema as Record<string, unknown>)['properties'] as Record<string, Record<string, unknown>> | undefined;
  if (!props) return [];
  return Object.entries(props).map(([key, def]) => ({
    key,
    type: String(def['type'] ?? 'string'),
    description: String(def['description'] ?? ''),
  }));
});

// The request a control was rendered for: the page shows the next request only after its flush, and a press before that
// is not for it.
function requestOf(event: Event): ElicitationRequest | undefined {
  const elicitation = currentElicitation.value;
  const rendered = event.currentTarget instanceof HTMLElement ? event.currentTarget.dataset.request : undefined;
  return elicitation && elicitation.elicitationId === rendered ? elicitation : undefined;
}

function handleAccept(event: Event) {
  const elicitation = requestOf(event);
  if (!elicitation) return;

  const content = elicitation.mode === 'form' ? { ...formValues.value } : undefined;

  postMessage({
    type: 'answerElicitation',
    elicitationId: elicitation.elicitationId,
    action: 'accept',
    ...(content !== undefined ? { content } : {}),
  });
  store.answerElicitation(elicitation.elicitationId, {
    action: 'accept',
    ...(content !== undefined ? { content } : {}),
  });
  formValues.value = {};
}

function handleDecline(event: Event) {
  const elicitation = requestOf(event);
  if (!elicitation) return;

  postMessage({
    type: 'answerElicitation',
    elicitationId: elicitation.elicitationId,
    action: 'decline',
  });
  store.answerElicitation(elicitation.elicitationId, { action: 'decline' });
  formValues.value = {};
}

function handleOpenUrl() {
  const url = currentElicitation.value?.url;
  if (url) {
    postMessage({ type: 'openExternalUrl', url });
  }
}

function updateFormValue(key: string, value: unknown) {
  formValues.value = { ...formValues.value, [key]: value };
}

function onFieldInput(prop: { key: string; type: unknown }, raw: string) {
  const numeric = prop.type === 'number' || prop.type === 'integer';
  updateFormValue(prop.key, numeric ? (raw === '' ? undefined : Number(raw)) : raw);
}
</script>

<template>
  <Transition name="t-up">
    <div
      v-if="currentElicitation"
      class="d-dock-shadow rounded-14"
      data-trusted
    >
      <!-- One bounded element that scrolls inside itself under its answers, so the whole card always fits the page. -->
      <!-- Keyed by the request: the next request is a new element, which starts held (useTrustedVisibility). -->
      <div
        ref="cardRef"
        :key="currentElicitation.elicitationId"
        class="max-h-[70dvh] overflow-x-hidden overflow-y-auto rounded-14 border border-[color-mix(in_srgb,var(--d-accent-fill)_45%,var(--d-border))] bg-(--d-card) text-(--d-text) [--attention-ring:var(--d-accent-fill)]"
        role="region"
        :aria-label="$t('elicitation.ariaLabel')"
        data-dock-prompt
        data-trusted
        data-testid="elicitation-card"
      >
        <header class="flex items-center gap-2.5 border-b border-(--d-border) bg-linear-to-b from-[color-mix(in_srgb,var(--d-accent-fill)_10%,transparent)] to-transparent px-3 py-2">
          <span
            class="d-ring [--tone:var(--d-accent-fill)] flex size-6.5 flex-none items-center justify-center rounded-lg bg-(--d-accent-soft) text-(--d-accent)"
            aria-hidden="true"
          >
            <Plug class="size-3.5" />
          </span>
          <div class="min-w-0 flex-1">
            <div class="truncate font-semibold">
              {{ $t('elicitation.title', { server: currentElicitation.serverName }) }}
            </div>
          </div>
        </header>
        <TrustedCheckingNote
          overlay
          class="bottom-0"
          :shown="explain"
          :text="$t('trusted.checkingVisible')"
        />

        <div class="px-3.5 pt-2.5 pb-2 text-13 text-pretty whitespace-pre-wrap">
          {{ currentElicitation.message }}
        </div>

        <div
          v-if="currentElicitation.mode === 'url' && currentElicitation.url"
          class="px-3.5 pb-3"
        >
          <button
            type="button"
            class="d-press flex h-7.5 items-center gap-1.5 rounded-9 border border-(--d-border2) px-3 text-12.5 transition-colors hover:bg-(--d-hover)"
            :aria-disabled="!isVisible || undefined"
            @click="handleOpenUrl"
          >
            <ExternalLink
              class="size-3.25"
              aria-hidden="true"
            />
            {{ $t('elicitation.openInBrowser') }}
          </button>
        </div>

        <div
          v-else-if="currentElicitation.mode === 'form' && schemaProperties.length > 0"
          class="space-y-2.5 px-3.5 pb-3"
        >
          <div
            v-for="prop in schemaProperties"
            :key="prop.key"
            class="flex flex-col gap-1"
          >
            <label
              v-if="prop.type === 'boolean'"
              class="flex items-center gap-2 text-12.5"
            >
              <input
                type="checkbox"
                :checked="!!formValues[prop.key]"
                class="accent-(--d-accent-fill)"
                @change="updateFormValue(prop.key, ($event.target as HTMLInputElement).checked)"
              >
              {{ prop.description || prop.key }}
            </label>
            <template v-else>
              <label
                :for="`elicitation-${prop.key}`"
                class="text-xs font-medium text-(--d-muted)"
              >{{ prop.description || prop.key }}</label>
              <input
                :id="`elicitation-${prop.key}`"
                :type="prop.type === 'number' || prop.type === 'integer' ? 'number' : 'text'"
                class="h-8.5 w-full rounded-10 border border-(--d-border2) bg-(--d-input) px-2.75 text-12.5 text-(--d-text) outline-none focus:border-(--d-accent-fill)"
                :value="formValues[prop.key] ?? ''"
                @input="onFieldInput(prop, ($event.target as HTMLInputElement).value)"
              >
            </template>
          </div>
        </div>

        <div class="sticky bottom-0 flex justify-end gap-2 border-t border-(--d-border) bg-(--d-card) bg-linear-to-b from-(--d-panel) to-(--d-panel) px-3.5 py-2.5">
          <button
            type="button"
            class="d-press flex h-7.5 items-center rounded-9 border border-(--d-border2) px-3 text-12.5 transition-colors hover:bg-(--d-hover)"
            :aria-disabled="!isVisible || undefined"
            :data-request="currentElicitation.elicitationId"
            @click="handleDecline"
          >
            {{ $t('elicitation.decline') }}
          </button>
          <button
            type="button"
            class="d-press flex h-7.5 items-center gap-1.5 rounded-9 bg-(--d-accent-fill) px-3.5 text-12.5 font-semibold text-(--d-on-accent) transition-[filter] hover:brightness-110"
            :aria-disabled="!isVisible || undefined"
            :data-request="currentElicitation.elicitationId"
            @click="handleAccept"
          >
            <Check
              class="size-3.25"
              aria-hidden="true"
            />
            {{ $t('elicitation.accept') }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>
