<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import type { ElicitationRequest } from '@shared/types/elicitation';
import { Button } from '@/components/ui/button';
import { useElicitationStore } from '@/stores/useElicitationStore';
import { useVSCode } from '@/composables/useVSCode';

const store = useElicitationStore();
const { postMessage } = useVSCode();

const currentElicitation = computed((): ElicitationRequest | undefined =>
  store.pendingElicitations[0]
);

const formValues = ref<Record<string, unknown>>({});

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

function handleAccept() {
  const elicitation = currentElicitation.value;
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

function handleDecline() {
  const elicitation = currentElicitation.value;
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
</script>

<template>
  <div
    v-if="currentElicitation"
    class="border-t border-border bg-background"
    role="region"
    aria-label="MCP server elicitation"
  >
    <div class="px-4 pt-3 pb-1">
      <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs bg-primary/20 text-primary border border-border">
        {{ currentElicitation.serverName }}
      </span>
    </div>

    <div class="px-4 py-2 text-sm text-foreground whitespace-pre-wrap">
      {{ currentElicitation.message }}
    </div>

    <!-- URL mode -->
    <template v-if="currentElicitation.mode === 'url'">
      <div class="px-4 pb-3">
        <Button
          v-if="currentElicitation.url"
          variant="outline"
          size="sm"
          class="mb-2"
          @click="handleOpenUrl"
        >
          Open in Browser
        </Button>
      </div>
    </template>

    <!-- Form mode -->
    <template v-else-if="currentElicitation.mode === 'form' && schemaProperties.length > 0">
      <div class="px-4 pb-3 space-y-2">
        <div v-for="prop in schemaProperties" :key="prop.key" class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">{{ prop.description || prop.key }}</label>
          <template v-if="prop.type === 'boolean'">
            <label class="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                :checked="!!formValues[prop.key]"
                class="accent-primary"
                @change="updateFormValue(prop.key, ($event.target as HTMLInputElement).checked)"
              />
              {{ prop.key }}
            </label>
          </template>
          <template v-else-if="prop.type === 'number' || prop.type === 'integer'">
            <input
              type="number"
              class="w-full px-2 py-1.5 text-sm rounded border border-border bg-card text-foreground focus:outline-none focus:border-primary"
              :value="formValues[prop.key] ?? ''"
              @input="updateFormValue(prop.key, ($event.target as HTMLInputElement).value === '' ? undefined : Number(($event.target as HTMLInputElement).value))"
            />
          </template>
          <template v-else>
            <input
              type="text"
              class="w-full px-2 py-1.5 text-sm rounded border border-border bg-card text-foreground focus:outline-none focus:border-primary"
              :value="formValues[prop.key] ?? ''"
              @input="updateFormValue(prop.key, ($event.target as HTMLInputElement).value)"
            />
          </template>
        </div>
      </div>
    </template>

    <div class="px-4 pb-3 flex justify-end gap-2 border-t border-border/30 pt-3">
      <Button variant="ghost" size="sm" @click="handleDecline">
        Decline
      </Button>
      <Button size="sm" @click="handleAccept">
        Accept
      </Button>
    </div>
  </div>
</template>
