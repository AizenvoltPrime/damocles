<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { FileCog, Folder, Laptop, ShieldAlert, ShieldQuestion } from 'lucide-vue-next';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import HostBadge from '@/components/HostBadge.vue';
import { visibleLines, visibleText } from '@shared/visible-text';
import type { OverlayAnswer, OverlayRequest } from '../../../preload/overlay-channels';

// What a dev container configuration runs and grants, asked before `devcontainer up`. Cancel is focused first and every way
// of closing refuses. Main owns the open state, so the dialog renders in place and its wrapper's leave plays the exit.
const props = defineProps<{ request: Extract<OverlayRequest, { kind: 'devcontainerTrust' }> }>();
const emit = defineEmits<{ answer: [answer: OverlayAnswer] }>();
const { t } = useI18n();

const hostName = computed(() => props.request.hostName ?? t('remote.devcontainerTrust.thisComputer'));
// a sentence names an SSH host by its name and this computer in words of its own
const sentence = (key: string): string => (props.request.hostName === undefined ? t(`${key}Local`) : t(key, { host: props.request.hostName }));
// the configuration's own property name beside its label; otherHostAccess gathers several
const configKey = (field: string): string | undefined => (field === 'otherHostAccess' ? undefined : field);
const dangers = computed(() => new Set(props.request.items.flatMap((entry) => entry.values.flatMap((value) => (value.danger ? [value.danger] : [])))));

let answered = false;
function choose(accept: boolean): void {
  if (answered) return;
  answered = true;
  emit('answer', { kind: 'devcontainerTrust', accept });
}

const cancelButton = ref<InstanceType<typeof Button> | null>(null);
function focusCancel(event: Event): void {
  event.preventDefault();
  (cancelButton.value?.$el as HTMLElement | undefined)?.focus();
}
</script>

<template>
  <AlertDialog
    :open="true"
    @update:open="(next: boolean) => !next && choose(false)"
  >
    <AlertDialogContent
      inline
      data-testid="devcontainer-trust"
      :data-changed="request.changed"
      class="grid max-h-[86vh] w-[min(36rem,calc(100%-2rem))] max-w-none grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0"
      :class="dangers.size > 0 && 'border-(--d-danger)/50'"
      @open-auto-focus="focusCancel"
    >
      <!-- ConfirmDialogLayout's header and footer, with a body that takes focus: the list may scroll with nothing focusable in it. -->
      <header class="flex items-start gap-3 px-4.5 pt-4.5 pb-3">
        <span
          aria-hidden="true"
          class="flex size-8 flex-none items-center justify-center rounded-10"
          :class="dangers.size > 0 ? 'bg-(--d-danger)/14 text-(--d-danger)' : 'bg-(--d-warning)/14 text-(--d-warning)'"
        >
          <component
            :is="dangers.size > 0 ? ShieldAlert : ShieldQuestion"
            class="size-4"
          />
        </span>
        <div class="min-w-0 flex-1 pt-0.5">
          <AlertDialogTitle class="text-15 font-semibold tracking-[-.01em]">
            {{ request.changed ? t('remote.devcontainerTrust.changedTitle') : t('remote.devcontainerTrust.firstTitle') }}
          </AlertDialogTitle>
          <AlertDialogDescription class="mt-1 text-12.5 text-pretty text-(--d-muted)">
            <span
              class="block"
              data-testid="devcontainer-trust-reason"
            >{{ sentence(request.changed ? 'remote.devcontainerTrust.changedBody' : 'remote.devcontainerTrust.firstBody') }}</span>
            <span
              v-for="danger in dangers"
              :key="danger"
              data-testid="devcontainer-trust-danger-summary"
              :data-danger="danger"
              class="mt-2 flex gap-2 rounded-8 bg-(--d-danger)/12 px-2.5 py-2 text-12 text-(--d-danger-text)"
            >
              <ShieldAlert
                aria-hidden="true"
                class="mt-0.5 size-3.5 shrink-0"
              />
              <span>{{ sentence(`remote.devcontainerTrust.danger.${danger}`) }}</span>
            </span>
          </AlertDialogDescription>
        </div>
      </header>

      <div
        tabindex="0"
        role="region"
        data-testid="devcontainer-trust-body"
        :aria-label="t('remote.devcontainerTrust.listLabel')"
        class="flex min-h-0 flex-col gap-3 overflow-y-auto px-4.5 pb-4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--d-accent)"
      >
        <div class="flex flex-col gap-1.5 rounded-10 bg-(--d-panel) px-3 py-2.5 text-12">
          <span class="flex min-w-0 items-center gap-2">
            <span class="w-20 shrink-0 text-(--d-muted)">{{ t('remote.devcontainerTrust.runsOn') }}</span>
            <HostBadge
              v-if="request.hostName !== undefined"
              :name="request.hostName"
              :color="request.hostColor"
              data-testid="devcontainer-trust-host"
            />
            <span
              v-else
              data-testid="devcontainer-trust-host"
              class="inline-flex items-center gap-1.5 text-(--d-text)"
            >
              <Laptop
                aria-hidden="true"
                class="size-3.5 text-(--d-muted)"
              />
              {{ hostName }}
            </span>
          </span>
          <span class="flex min-w-0 items-start gap-2">
            <span class="w-20 shrink-0 text-(--d-muted)">{{ t('remote.devcontainerTrust.folder') }}</span>
            <Folder
              aria-hidden="true"
              class="mt-0.5 size-3.5 shrink-0 text-(--d-muted)"
            />
            <span
              dir="ltr"
              data-testid="devcontainer-trust-folder"
              class="min-w-0 font-mono text-11.5 break-all text-(--d-text)"
            >{{ visibleText(request.folder) }}</span>
          </span>
          <span class="flex min-w-0 items-start gap-2">
            <span class="w-20 shrink-0 text-(--d-muted)">{{ t('remote.devcontainerTrust.config') }}</span>
            <FileCog
              aria-hidden="true"
              class="mt-0.5 size-3.5 shrink-0 text-(--d-muted)"
            />
            <span
              dir="ltr"
              data-testid="devcontainer-trust-config"
              class="min-w-0 font-mono text-11.5 break-all text-(--d-text)"
            >{{ visibleText(request.configPath) }}</span>
          </span>
        </div>

        <dl
          v-if="request.items.length > 0"
          class="flex flex-col gap-3"
          data-testid="devcontainer-trust-items"
        >
          <div
            v-for="(entry, index) in request.items"
            :key="entry.field"
            data-testid="devcontainer-trust-item"
            :data-field="entry.field"
            class="d-row-reveal flex flex-col gap-1"
            :style="{ '--reveal-index': index }"
          >
            <dt class="flex flex-wrap items-baseline gap-x-2 text-11 font-semibold tracking-wide text-(--d-muted) uppercase">
              {{ t(`remote.devcontainerTrust.field.${entry.field}`) }}
              <code
                v-if="configKey(entry.field)"
                dir="ltr"
                class="font-mono text-10.5 font-normal tracking-normal text-(--d-faint-text) normal-case"
              >{{ configKey(entry.field) }}</code>
            </dt>
            <dd
              v-for="(value, valueIndex) in entry.values"
              :key="valueIndex"
              data-testid="devcontainer-trust-value"
              :data-danger="value.danger"
              class="flex flex-col gap-1.5 rounded-8 border px-2.5 py-2"
              :class="value.danger ? 'border-(--d-danger)/45 border-s-[0.1875rem] border-s-(--d-danger) bg-(--d-danger)/8' : 'border-(--d-border) bg-(--d-code)'"
            >
              <span
                v-if="value.danger"
                data-testid="devcontainer-trust-danger"
                class="inline-flex items-center gap-1.5 self-start rounded-5 bg-(--d-danger)/15 px-1.5 py-0.5 text-10.5 font-semibold text-(--d-danger-text)"
              >
                <ShieldAlert
                  aria-hidden="true"
                  class="size-3"
                />
                {{ t(`remote.devcontainerTrust.dangerTag.${value.danger}`) }}
              </span>
              <code
                dir="ltr"
                class="bg-transparent font-mono text-11.5/relaxed break-all whitespace-pre-wrap text-(--d-text)"
              >{{ visibleLines(value.text) }}</code>
            </dd>
          </div>
        </dl>
        <p
          v-else
          data-testid="devcontainer-trust-nothing"
          class="text-12.5 text-(--d-muted)"
        >
          {{ sentence('remote.devcontainerTrust.nothing') }}
        </p>
        <p class="text-11.5 text-(--d-faint-text)">
          {{ t('remote.devcontainerTrust.once') }}
        </p>
      </div>

      <footer class="flex flex-wrap items-center justify-end gap-2 border-t border-(--d-border) bg-(--d-panel) px-3.5 py-2.5">
        <Button
          ref="cancelButton"
          type="button"
          variant="outline"
          size="sm"
          data-testid="devcontainer-trust-cancel"
          class="h-7.5 rounded-9 border-(--d-border2) bg-transparent px-3 text-12.5"
          @click="choose(false)"
        >
          {{ t('remote.devcontainerTrust.cancel') }}
        </Button>
        <Button
          type="button"
          size="sm"
          :variant="dangers.size > 0 ? 'destructive' : 'default'"
          data-testid="devcontainer-trust-accept"
          class="h-7.5 rounded-9 px-3.5 text-12.5 font-semibold"
          @click="choose(true)"
        >
          {{ t('remote.devcontainerTrust.accept') }}
        </Button>
      </footer>
    </AlertDialogContent>
  </AlertDialog>
</template>
