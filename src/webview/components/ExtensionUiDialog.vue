<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';
import { storeToRefs } from 'pinia';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useExtensionUiStore } from '@/stores/useExtensionUiStore';
import { useVSCode } from '@/composables/useVSCode';

const store = useExtensionUiStore();
const { request } = storeToRefs(store);
const { postMessage } = useVSCode();

const textValue = ref('');
const inputRef = ref<{ $el?: HTMLElement } | HTMLElement | null>(null);
const dialogRef = ref<HTMLElement | null>(null);

watch(
  request,
  (req) => {
    if (!req) return;
    if (req.kind === 'input' || req.kind === 'editor') {
      textValue.value = req.prefill ?? '';
      nextTick(() => {
        const root = inputRef.value;
        const el = root && typeof root === 'object' && '$el' in root ? (root.$el as HTMLElement | undefined) : (root as HTMLElement | null);
        if (!el) return;
        const focusable = el.matches('input, textarea') ? el : el.querySelector<HTMLElement>('input, textarea');
        focusable?.focus();
      });
    } else {
      // select/confirm have no focusable field, so focus the container — otherwise the keydown lands on
      // document.body and the Esc handler (bound to this element) never fires.
      nextTick(() => dialogRef.value?.focus());
    }
  },
  { immediate: true },
);

function respond(value: string | boolean | null): void {
  const req = request.value;
  if (!req) return;
  postMessage({ type: 'extensionUiResponse', requestId: req.requestId, value });
  store.clear();
}

function cancel(): void {
  respond(request.value?.kind === 'confirm' ? false : null);
}
</script>

<template>
  <div
    v-if="request"
    ref="dialogRef"
    tabindex="-1"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 outline-none"
    @keydown.esc="cancel"
  >
    <div class="w-full max-w-md rounded-lg border border-border bg-background p-4 shadow-lg">
      <h3 class="mb-2 text-sm font-semibold text-foreground">
        {{ request.title }}
      </h3>
      <p
        v-if="request.message"
        class="mb-3 whitespace-pre-wrap text-sm text-muted-foreground"
      >
        {{ request.message }}
      </p>

      <div
        v-if="request.kind === 'select'"
        class="flex flex-col gap-2"
      >
        <Button
          v-for="option in request.options ?? []"
          :key="option"
          variant="outline"
          class="justify-start"
          @click="respond(option)"
        >
          {{ option }}
        </Button>
      </div>

      <div
        v-else-if="request.kind === 'confirm'"
        class="flex justify-end gap-2"
      >
        <Button
          variant="outline"
          @click="respond(false)"
        >
          No
        </Button>
        <Button @click="respond(true)">
          Yes
        </Button>
      </div>

      <div
        v-else-if="request.kind === 'input'"
        class="flex flex-col gap-3"
      >
        <Input
          ref="inputRef"
          v-model="textValue"
          :placeholder="request.placeholder ?? ''"
          @keydown.enter="respond(textValue)"
        />
        <div class="flex justify-end gap-2">
          <Button
            variant="outline"
            @click="cancel"
          >
            Cancel
          </Button>
          <Button @click="respond(textValue)">
            OK
          </Button>
        </div>
      </div>

      <div
        v-else-if="request.kind === 'editor'"
        class="flex flex-col gap-3"
      >
        <Textarea
          ref="inputRef"
          v-model="textValue"
          rows="8"
          class="font-mono text-xs"
        />
        <div class="flex justify-end gap-2">
          <Button
            variant="outline"
            @click="cancel"
          >
            Cancel
          </Button>
          <Button @click="respond(textValue)">
            Save
          </Button>
        </div>
      </div>

      <div
        v-if="request.kind === 'select'"
        class="mt-3 flex justify-end"
      >
        <Button
          variant="ghost"
          size="sm"
          @click="cancel"
        >
          Cancel
        </Button>
      </div>
    </div>
  </div>
</template>
