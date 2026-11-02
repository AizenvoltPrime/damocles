<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, useId, useTemplateRef, watch, type ComponentPublicInstance } from 'vue';
import { useI18n } from 'vue-i18n';
import { Brain, LoaderCircle, Trash2 } from 'lucide-vue-next';
import SettingsRow from '@/components/settings/SettingsRow.vue';
import SettingButton from '@/components/settings/controls/SettingButton.vue';
import ConfirmDialogLayout from '@/components/ConfirmDialogLayout.vue';
import { AlertDialog, AlertDialogContent } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import type { DamoclesOverlayApi, HeldMemoryQueue, HeldMemoryResult } from '../../../preload/overlay-channels';
import { answerOf } from '../popup-answer';

type Action = 'deliver' | 'discard';

// Settings, Remote hosts: the global memories a host holds for devices that stopped attaching, one row per held device, each
// delivered to this computer or discarded after a confirm. The row stays after the last one leaves, so its result is read out.
const props = defineProps<{ api: DamoclesOverlayApi; hostId: string; hostName: string; queues: readonly HeldMemoryQueue[] }>();
const { t, locale } = useI18n();
const idBase = useId();

// Queues this view saw delivered or discarded, hidden until main's push drops them.
const handled = shallowRef<ReadonlySet<string>>(new Set());
watch(() => props.queues, (queues) => {
  const held = new Set(queues.map((queue) => queue.queueId));
  handled.value = new Set([...handled.value].filter((queueId) => held.has(queueId)));
});
const shown = computed(() => props.queues.filter((queue) => !handled.value.has(queue.queueId)));

const busy = shallowRef<{ readonly queueId: string; readonly action: Action } | undefined>();
const failure = shallowRef<{ readonly queueId: string; readonly text: string } | undefined>();
const outcome = ref<string | undefined>();

const dateFormat = computed(() => new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium' }));
const named = (queue: HeldMemoryQueue): { named: Record<string, unknown> } => ({
  named: { count: queue.count, date: dateFormat.value.format(queue.lastSeen), name: props.hostName },
});
// an id token holds no spaces, which would split an aria-describedby list
const textId = (queue: HeldMemoryQueue): string => `${idBase}-${encodeURIComponent(queue.queueId)}`;

const list = useTemplateRef<ComponentPublicInstance>('list');
const outcomeText = useTemplateRef<HTMLElement>('outcomeText');
const rowOf = (queueId: string): HTMLElement | undefined => [...((list.value?.$el as HTMLElement | undefined)?.querySelectorAll<HTMLElement>('[data-testid="held-memory-queue"]') ?? [])].find((row) => row.dataset.queueId === queueId);

// Focus goes to the row that took the place of one that left, else the one before it, else the result.
function focusNear(index: number): void {
  const next = shown.value[Math.min(index, shown.value.length - 1)];
  const target = next ? rowOf(next.queueId)?.querySelector<HTMLElement>('[data-action="deliver"]') : outcomeText.value;
  target?.focus();
}

let leftIndex = 0;
async function leave(queue: HeldMemoryQueue, index: number, text: string): Promise<void> {
  leftIndex = index;
  // a push that dropped the row while the call ran left the focus on the body
  const hadFocus = (rowOf(queue.queueId)?.contains(document.activeElement) ?? false) || document.activeElement === document.body;
  if (props.queues.some((each) => each.queueId === queue.queueId)) handled.value = new Set([...handled.value, queue.queueId]);
  outcome.value = text;
  await nextTick();
  if (hadFocus) focusNear(leftIndex);
}

async function act(queue: HeldMemoryQueue, action: Action): Promise<void> {
  if (busy.value) return;
  failure.value = undefined;
  outcome.value = undefined;
  busy.value = { queueId: queue.queueId, action };
  const index = Math.max(0, shown.value.findIndex((each) => each.queueId === queue.queueId));
  let result: HeldMemoryResult | undefined;
  try {
    result = await answerOf(action === 'deliver' ? props.api.deliverHeldMemory(props.hostId, queue.queueId) : props.api.discardHeldMemory(props.hostId, queue.queueId));
  } catch {
    failure.value = { queueId: queue.queueId, text: t(`remote.heldMemory.failed.${action}`, { name: props.hostName }) };
    return;
  } finally {
    busy.value = undefined;
  }
  if (!result) return;
  if (result.ok) await leave(queue, index, t(`remote.heldMemory.${action === 'deliver' ? 'delivered' : 'discarded'}`, queue.count, named(queue)));
  else if (result.code === 'gone') await leave(queue, index, t('remote.heldMemory.gone'));
  else failure.value = { queueId: queue.queueId, text: t(`remote.heldMemory.failure.${result.code}`, { name: props.hostName }) };
}

// The confirm keeps its queue through its exit, after it closed.
const confirming = ref(false);
const confirmed = shallowRef<HeldMemoryQueue | undefined>();
const cancelButton = useTemplateRef<InstanceType<typeof Button>>('cancelButton');

function askDiscard(queue: HeldMemoryQueue): void {
  if (busy.value) return;
  confirmed.value = queue;
  confirming.value = true;
}

function chooseDiscard(discard: boolean): void {
  confirming.value = false;
  if (discard && confirmed.value) void act(confirmed.value, 'discard');
}

function focusCancel(event: Event): void {
  event.preventDefault();
  (cancelButton.value?.$el as HTMLElement | undefined)?.focus();
}

function returnFocus(event: Event): void {
  event.preventDefault();
  const queueId = confirmed.value?.queueId;
  const row = queueId === undefined || handled.value.has(queueId) ? undefined : rowOf(queueId);
  if (row) row.querySelector<HTMLElement>('[data-action="discard"]')?.focus();
  else focusNear(leftIndex);
}
</script>

<template>
  <SettingsRow
    v-if="shown.length > 0 || outcome"
    id="remote-host-held-memory"
    :description="shown.length > 0 ? t('remote.heldMemory.description', { name: hostName }) : t('remote.heldMemory.noneLeft', { name: hostName })"
  >
    <template #note>
      <div aria-live="polite">
        <p
          v-if="outcome"
          ref="outcomeText"
          role="status"
          tabindex="-1"
          data-testid="held-memory-outcome"
          class="sm-feedback w-fit rounded-5"
        >
          {{ outcome }}
        </p>
      </div>
    </template>
    <template #expand>
      <!-- a leaving item is absolute across the list, so the list carries no padding of its own -->
      <div class="w-full px-3.5 pb-2.5">
        <TransitionGroup
          ref="list"
          tag="ul"
          name="t-row"
          class="relative flex flex-col gap-px"
        >
          <li
            v-for="queue in shown"
            :key="queue.queueId"
            data-testid="held-memory-queue"
            :data-queue-id="queue.queueId"
            :aria-busy="busy?.queueId === queue.queueId"
            class="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1 py-1 text-12.5"
          >
            <Brain
              aria-hidden="true"
              class="size-3.5 shrink-0 text-(--d-muted)"
            />
            <span
              :id="textId(queue)"
              data-testid="held-memory-text"
              class="min-w-0 flex-1"
            >{{ t('remote.heldMemory.queue', queue.count, named(queue)) }}</span>
            <span class="flex shrink-0 items-center gap-1.5">
              <SettingButton
                variant="primary"
                data-action="deliver"
                data-testid="held-memory-deliver"
                :aria-describedby="textId(queue)"
                :aria-disabled="busy !== undefined || undefined"
                :class="{ 'cursor-default opacity-50': busy !== undefined }"
                @click="act(queue, 'deliver')"
              >
                <LoaderCircle
                  v-if="busy?.queueId === queue.queueId && busy.action === 'deliver'"
                  aria-hidden="true"
                  class="size-3 d-spinning"
                />
                {{ t('remote.heldMemory.deliver') }}
              </SettingButton>
              <SettingButton
                variant="danger"
                data-action="discard"
                data-testid="held-memory-discard"
                :aria-describedby="textId(queue)"
                :aria-disabled="busy !== undefined || undefined"
                :class="{ 'cursor-default opacity-50': busy !== undefined }"
                @click="askDiscard(queue)"
              >
                <LoaderCircle
                  v-if="busy?.queueId === queue.queueId && busy.action === 'discard'"
                  aria-hidden="true"
                  class="size-3 d-spinning"
                />
                {{ t('remote.heldMemory.discard') }}
              </SettingButton>
            </span>
            <p
              v-if="failure?.queueId === queue.queueId"
              role="alert"
              data-testid="held-memory-failure"
              class="basis-full pl-5.5 text-11.5 text-(--d-danger-text)"
            >
              {{ failure.text }}
            </p>
          </li>
        </TransitionGroup>
      </div>
    </template>
  </SettingsRow>
  <AlertDialog
    :open="confirming"
    @update:open="(next: boolean) => !next && chooseDiscard(false)"
  >
    <AlertDialogContent
      data-testid="held-memory-confirm"
      class="max-w-md gap-0 overflow-hidden border-(--d-danger)/50 p-0"
      @open-auto-focus="focusCancel"
      @close-auto-focus="returnFocus"
    >
      <ConfirmDialogLayout
        v-if="confirmed"
        :icon="Trash2"
        tone="danger"
        :title="t('remote.heldMemory.confirm.title', confirmed.count, named(confirmed))"
        :description="t('remote.heldMemory.confirm.body', confirmed.count, named(confirmed))"
      >
        <template #footer>
          <Button
            ref="cancelButton"
            type="button"
            variant="outline"
            size="sm"
            data-testid="held-memory-confirm-cancel"
            class="h-7.5 rounded-9 border-(--d-border2) bg-transparent px-3 text-12.5"
            @click="chooseDiscard(false)"
          >
            {{ t('remote.heldMemory.confirm.cancel') }}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            data-testid="held-memory-confirm-discard"
            class="h-7.5 gap-1.5 rounded-9 px-3.5 text-12.5 font-semibold [&_svg]:size-3.25"
            @click="chooseDiscard(true)"
          >
            <Trash2 aria-hidden="true" />
            {{ t('remote.heldMemory.confirm.discard') }}
          </Button>
        </template>
      </ConfirmDialogLayout>
    </AlertDialogContent>
  </AlertDialog>
</template>
