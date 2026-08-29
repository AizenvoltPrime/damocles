<script setup lang="ts">
import { ref, shallowRef, watch, nextTick } from 'vue';
import { storeToRefs } from 'pinia';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useExtensionUiStore, type ExtensionUiRequest } from '@/stores/useExtensionUiStore';
import { useVSCode } from '@/composables/useVSCode';
import { MODAL_Z_INDEX } from '@/composables/useOverlayEscape';

const store = useExtensionUiStore();
const { current, queue } = storeToRefs(store);
const { postMessage } = useVSCode();

const textValue = ref('');
const inputRef = ref<{ $el?: HTMLElement } | HTMLElement | null>(null);
const dialogRef = ref<HTMLElement | null>(null);

/**
 * The request this dialog is RENDERED against — both the markup and the answer handlers read it, so a
 * click can only ever answer the request the user was actually shown. `current` is a computed over the
 * queue and flips the instant the extension withdraws the head (`extensionUiCancel`); reading it when
 * a click is handled would post the user's answer against whichever request was promoted underneath
 * it — a prompt from a different agent that the user never saw, dismissed as answered.
 */
const displayed = shallowRef<ExtensionUiRequest | null>(null);

// Watches the QUEUE HEAD, not a single slot: answering dialog #1 promotes #2, and that head change
// must re-run focus setup exactly as a null -> value transition does. Pre-flush, so `displayed` moves
// with the re-render rather than ahead of it.
watch(
  current,
  (req) => {
    displayed.value = req;
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
  const req = displayed.value;
  if (!req) return;
  postMessage({ type: 'extensionUiResponse', requestId: req.requestId, value });
  store.resolve(req.requestId);
}

function cancel(): void {
  respond(displayed.value?.kind === 'confirm' ? false : null);
}
</script>

<template>
  <div
    v-if="displayed"
    ref="dialogRef"
    tabindex="-1"
    class="fixed inset-0 flex items-center justify-center bg-black/50 p-4 outline-none"
    :style="{ zIndex: MODAL_Z_INDEX }"
    @keydown.esc="cancel"
  >
    <div class="w-full max-w-md rounded-lg border border-border bg-background p-4 shadow-lg">
      <!-- `agentName` is untrusted (model- or user-authored) and is sanitized extension-side at capture;
           it stays TEXT here — never v-html.
           The literal "Agent" is load-bearing, not decoration: without a Damocles-authored word saying
           what the string IS, a badge holding only model-chosen text sits where users read panel chrome,
           and a specialist named "Verified — approved" reads as the panel saying so. Sanitizing stops
           line forging; only a frame stops semantic impersonation. `dir="ltr"` + bidi isolation keep a
           name that survived sanitizing from re-ordering the label it sits next to.
           The badge reads `displayed` (pinned to what the user was shown) while the counter reads the
           live queue — deliberately different: the badge is an identity claim that must match the form
           below it, the counter is a live depth indicator that should reflect an arrival. -->
      <div
        v-if="displayed.agentName || queue.length > 1"
        class="mb-2 flex items-center gap-2 text-xs"
      >
        <Badge
          v-if="displayed.agentName"
          variant="secondary"
          class="max-w-[16rem] truncate"
        >
          <span class="mr-1 text-muted-foreground">Agent</span>
          <span
            dir="ltr"
            class="[unicode-bidi:isolate]"
          >{{ displayed.agentName }}</span>
        </Badge>
        <span
          v-if="queue.length > 1"
          class="ml-auto text-muted-foreground"
        >
          1 of {{ queue.length }}
        </span>
      </div>

      <!-- `whitespace-pre-wrap` because the title is AUTHORED as lines: the MCP elicitation renderer
           builds "MCP Input Request\nServer: <name>\n\n<server message>", and its flattening exists so a
           server cannot forge that `Server:` attribution line. Collapsing the newlines here would run
           the trusted attribution and the third-party message together as one bold sentence, which
           spends the producer's line discipline for nothing. -->
      <h3 class="mb-2 whitespace-pre-wrap text-sm font-semibold text-foreground">
        {{ displayed.title }}
      </h3>
      <p
        v-if="displayed.message"
        class="mb-3 whitespace-pre-wrap text-sm text-muted-foreground"
      >
        {{ displayed.message }}
      </p>

      <div
        v-if="displayed.kind === 'select'"
        class="flex flex-col gap-2"
      >
        <Button
          v-for="option in displayed.options ?? []"
          :key="option"
          variant="outline"
          class="justify-start"
          @click="respond(option)"
        >
          {{ option }}
        </Button>
      </div>

      <div
        v-else-if="displayed.kind === 'confirm'"
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
        v-else-if="displayed.kind === 'input'"
        class="flex flex-col gap-3"
      >
        <Input
          ref="inputRef"
          v-model="textValue"
          :placeholder="displayed.placeholder ?? ''"
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
        v-else-if="displayed.kind === 'editor'"
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
        v-if="displayed.kind === 'select'"
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
