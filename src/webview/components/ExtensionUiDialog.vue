<script setup lang="ts">
import { computed, defineComponent, ref, shallowRef, watch, nextTick } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useExtensionUiStore, type ExtensionUiRequest } from '@/stores/useExtensionUiStore';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { MODAL_Z_INDEX, useOverlayEscape } from '@/composables/useOverlayEscape';

const { t } = useI18n();
const store = useExtensionUiStore();
const { current, queue } = storeToRefs(store);
const { postMessage } = usePlatformBridge();

// Holds the modal layer of the overlay stack only while a request is answerable; the closing dialog holds none.
const ModalStackEntry = defineComponent({
  props: { onClose: { type: Function, required: true } },
  setup(props) {
    useOverlayEscape(() => props.onClose(), { modal: true });
    return () => null;
  },
});
const zIndex = MODAL_Z_INDEX;

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
/** What the markup draws: the last request shown, kept while the dialog plays its exit after the queue empties. Never answered. */
const shown = shallowRef<ExtensionUiRequest | null>(null);

// Watches the QUEUE HEAD, not a single slot: answering dialog #1 promotes #2, and that head change
// must re-run focus setup exactly as a null -> value transition does. Pre-flush, so `displayed` moves
// with the re-render rather than ahead of it.
watch(
  current,
  (req) => {
    displayed.value = req;
    if (req) shown.value = req;
    // A typed value (a password, a pasted OAuth code) never outlives the request it was typed for.
    textValue.value = '';
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
    } else if (req.kind === 'select') {
      nextTick(() => dialogRef.value?.querySelector<HTMLElement>('input')?.focus());
    } else {
      // confirm has no field; focusing the container keeps focus inside the dialog's focus trap.
      nextTick(() => dialogRef.value?.focus());
    }
  },
  { immediate: true },
);

/** Items answer with their id; bare options answer with the label, as they always have. Drawn from `shown`, so the list survives the exit. */
const selectEntries = computed(() => {
  const req = shown.value;
  if (req?.kind !== 'select') return [];
  if (req.items) return req.items.map((item) => ({ value: item.id, label: item.label, description: item.description, detail: item.detail }));
  return (req.options ?? []).map((option) => ({ value: option, label: option, description: undefined, detail: undefined }));
});

function respond(value: string | boolean | null): void {
  const req = displayed.value;
  if (!req) return;
  postMessage({ type: 'extensionUiResponse', requestId: req.requestId, value });
  store.resolve(req.requestId);
}

function onSelect(value: unknown): void {
  if (typeof value === 'string') respond(value);
}

function cancel(): void {
  respond(displayed.value?.kind === 'confirm' ? false : null);
}

// reka dismisses this dialog on Escape only while the overlay stack yields Escape to an open reka layer beneath it, such as a modal dialog.
function onOpenChange(open: boolean): void {
  if (!open) cancel();
}
</script>

<template>
  <ModalStackEntry
    v-if="displayed"
    :on-close="cancel"
  />
  <DialogRoot
    v-if="shown"
    :open="displayed !== null"
    @update:open="onOpenChange"
  >
    <DialogPortal>
      <DialogOverlay
        class="d-scrim fixed inset-0 bg-(--d-scrim) backdrop-blur-xs"
        :style="{ zIndex }"
      />
      <DialogContent
        data-overlay-layer
        data-testid="extension-ui-dialog"
        class="d-dialog fixed left-1/2 top-1/2 w-[calc(100%-2rem)] max-w-md -translate-1/2 rounded-2xl border border-(--d-border2) bg-(--d-card) p-4 text-(--d-text) shadow-(--d-shadow) outline-none"
        :style="{ zIndex }"
        :aria-describedby="undefined"
        @pointer-down-outside="(e: Event) => e.preventDefault()"
      >
        <div
          ref="dialogRef"
          tabindex="-1"
          class="outline-none"
        >
          <!-- `agentName` is untrusted (model- or user-authored) and is sanitized extension-side at capture;
               it stays TEXT here — never v-html.
               The literal "Agent" is load-bearing, not decoration: without a Damocles-authored word saying
               what the string IS, a badge holding only model-chosen text sits where users read panel chrome,
               and a specialist named "Verified — approved" reads as the panel saying so. Sanitizing stops
               line forging; only a frame stops semantic impersonation. `dir="ltr"` + bidi isolation keep a
               name that survived sanitizing from re-ordering the label it sits next to.
               The badge reads `shown` (pinned to what the user was shown) while the counter reads the
               live queue — deliberately different: the badge is an identity claim that must match the form
               below it, the counter is a live depth indicator that should reflect an arrival. -->
          <div
            v-if="shown.agentName || queue.length > 1"
            class="mb-2 flex items-center gap-2 text-xs"
          >
            <Badge
              v-if="shown.agentName"
              variant="secondary"
              class="max-w-[16rem] truncate"
            >
              <span class="mr-1 text-muted-foreground">{{ t('extensionUi.agent') }}</span>
              <span
                dir="ltr"
                class="[unicode-bidi:isolate]"
              >{{ shown.agentName }}</span>
            </Badge>
            <span
              v-if="queue.length > 1"
              class="ml-auto text-muted-foreground"
            >
              {{ t('extensionUi.queuePosition', { total: queue.length }) }}
            </span>
          </div>

          <!-- `whitespace-pre-wrap` because the title is AUTHORED as lines: the MCP elicitation renderer
               builds "MCP Input Request\nServer: <name>\n\n<server message>", and its flattening exists so a
               server cannot forge that `Server:` attribution line. Collapsing the newlines here would run
               the trusted attribution and the third-party message together as one bold sentence, which
               spends the producer's line discipline for nothing. -->
          <DialogTitle
            as="h3"
            class="mb-2 whitespace-pre-wrap text-sm font-semibold text-foreground"
          >
            {{ shown.title }}
          </DialogTitle>
          <p
            v-if="shown.message"
            class="mb-3 whitespace-pre-wrap text-sm text-muted-foreground"
          >
            {{ shown.message }}
          </p>

          <Command
            v-if="shown.kind === 'select'"
            :key="shown.requestId"
            highlight-on-hover
            class="rounded-md border border-border bg-background"
            @update:model-value="onSelect"
          >
            <CommandInput :placeholder="shown.placeholder ?? t('extensionUi.filterPlaceholder')" />
            <CommandList>
              <CommandEmpty>{{ t('extensionUi.noMatches') }}</CommandEmpty>
              <CommandGroup>
                <CommandItem
                  v-for="entry in selectEntries"
                  :key="entry.value"
                  :value="entry.value"
                  class="flex-col items-start gap-0.5"
                >
                  <span class="flex w-full items-baseline gap-2">
                    <span class="min-w-0 truncate">{{ entry.label }}</span>
                    <span
                      v-if="entry.description"
                      class="min-w-0 truncate text-xs text-muted-foreground"
                    >{{ entry.description }}</span>
                  </span>
                  <span
                    v-if="entry.detail"
                    class="w-full truncate text-xs text-muted-foreground"
                  >{{ entry.detail }}</span>
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>

          <div
            v-else-if="shown.kind === 'confirm'"
            class="flex justify-end gap-2"
          >
            <Button
              variant="outline"
              @click="respond(false)"
            >
              {{ t('common.no') }}
            </Button>
            <Button @click="respond(true)">
              {{ t('common.yes') }}
            </Button>
          </div>

          <div
            v-else-if="shown.kind === 'input'"
            class="flex flex-col gap-3"
          >
            <Input
              ref="inputRef"
              v-model="textValue"
              :type="shown.password ? 'password' : 'text'"
              :autocomplete="shown.password ? 'new-password' : 'off'"
              spellcheck="false"
              :aria-label="shown.title"
              :placeholder="shown.placeholder ?? ''"
              @keydown.enter="respond(textValue)"
            />
            <div class="flex justify-end gap-2">
              <Button
                variant="outline"
                @click="cancel"
              >
                {{ t('common.cancel') }}
              </Button>
              <Button @click="respond(textValue)">
                {{ t('extensionUi.ok') }}
              </Button>
            </div>
          </div>

          <div
            v-else-if="shown.kind === 'editor'"
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
                {{ t('common.cancel') }}
              </Button>
              <Button @click="respond(textValue)">
                {{ t('common.save') }}
              </Button>
            </div>
          </div>

          <div
            v-if="shown.kind === 'select'"
            class="mt-3 flex justify-end"
          >
            <Button
              variant="ghost"
              size="sm"
              @click="cancel"
            >
              {{ t('common.cancel') }}
            </Button>
          </div>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
