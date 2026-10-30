<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ArrowRight, CircleX, Folder, FolderTree, Image as ImageIcon, LoaderCircle, MessageSquare, RotateCw, Send, SquareTerminal, TriangleAlert } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import type { WorktreeAction, WorktreeStateData } from '@shared/types/messages';
import { visibleLines, visibleText } from '@shared/visible-text';
import { useLocalizedText } from '@/composables/useLocalizedText';

/**
 * The composer's worktree states above the input (D30, D32): creating and setting up with Send now, a failed setup with Send
 * anyway and Retry, a failed creation with why it failed, Retry and Run in project folder. Each state morphs into the next.
 * The held prompt and the setup step come from core's worktree state. A setup after a hand-off holds nothing until the user
 * sends, so it offers no Send now and its failure offers Continue without setup.
 */
const props = defineProps<{ state: WorktreeStateData }>();
const emit = defineEmits<{ action: [action: WorktreeAction] }>();
const { t } = useI18n();
const { rt } = useLocalizedText();

const kind = computed(() => {
  const phase = props.state.phase;
  return phase === 'creating' || phase === 'settingUp' || phase === 'setupFailed' || phase === 'createFailed' ? phase : null;
});
const busy = computed(() => kind.value === 'creating' || kind.value === 'settingUp');

// The wait's clock, from when this card first showed work in progress.
const startedAt = ref<number | null>(null);
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
watch(busy, (isBusy) => {
  clearInterval(timer);
  timer = undefined;
  if (!isBusy) return;
  startedAt.value ??= Date.now();
  now.value = Date.now();
  timer = setInterval(() => (now.value = Date.now()), 1000);
}, { immediate: true });
watch(() => props.state.phase, (phase) => {
  if (phase !== 'creating' && phase !== 'settingUp') startedAt.value = null;
});
onBeforeUnmount(() => clearInterval(timer));
const elapsed = computed(() => {
  const seconds = startedAt.value === null ? 0 : Math.max(0, Math.floor((now.value - startedAt.value) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
});

function act(action: WorktreeAction): void {
  emit('action', action);
}

const heldPrompt = computed(() => props.state.heldPrompt);
const step = computed(() => (kind.value === 'settingUp' ? props.state.setupStep : undefined));
const stepCommand = computed(() => (step.value ? visibleText(step.value.command) : ''));

const button = 'd-press h-7 gap-1.5 rounded-7 px-2.75 text-xs font-medium focus-visible:ring-1 focus-visible:ring-(--d-accent) focus-visible:ring-offset-0 [&_svg]:size-3.25';
const plainButton = `${button} border-(--d-border2) bg-transparent text-(--d-text) hover:bg-(--d-hover) hover:text-(--d-text)`;
const fillButton = `${button} bg-(--d-accent) font-semibold text-(--d-on-accent) hover:bg-(--d-accent) hover:brightness-110`;
</script>

<template>
  <Transition name="t-up">
    <div
      v-if="kind"
      class="relative mb-2 overflow-hidden rounded-10 border bg-(--d-card)"
      :class="kind === 'setupFailed' || kind === 'createFailed' ? 'border-[color-mix(in_srgb,var(--d-danger)_40%,var(--d-border))]' : 'border-(--d-border)'"
      data-testid="worktree-status"
      :data-phase="kind"
    >
      <!-- One grid cell, so a state morphs into the next in place; its track is the card's width, so long text truncates or wraps. -->
      <div class="grid grid-cols-1">
        <Transition
          name="t-morph"
        >
          <div
            :key="kind"
            class="col-start-1 row-start-1 px-3 py-2.5"
            :role="kind === 'setupFailed' || kind === 'createFailed' ? 'alert' : 'status'"
          >
            <div class="flex items-center gap-2 text-12.5">
              <LoaderCircle
                v-if="busy"
                aria-hidden="true"
                class="d-spinning size-3.5 shrink-0 text-(--d-accent)"
              />
              <CircleX
                v-else-if="kind === 'setupFailed'"
                aria-hidden="true"
                class="size-3.5 shrink-0 text-(--d-danger)"
              />
              <TriangleAlert
                v-else
                aria-hidden="true"
                class="size-3.5 shrink-0 text-(--d-danger)"
              />
              <span
                class="min-w-0 truncate font-medium"
                data-testid="worktree-status-title"
              >
                <template v-if="kind === 'creating'">{{ t('worktree.creating') }}</template>
                <template v-else-if="kind === 'settingUp'">{{ t('worktree.settingUp') }}</template>
                <template v-else-if="kind === 'setupFailed'">{{ t('worktree.setupFailed', { code: state.exitCode ?? '?' }) }}</template>
                <template v-else>{{ t('worktree.createFailed') }}</template>
              </span>
              <span
                v-if="state.branch && kind !== 'createFailed'"
                class="flex min-w-0 items-center gap-1 font-mono text-11 text-(--d-faint-text)"
                dir="ltr"
              >
                <FolderTree
                  aria-hidden="true"
                  class="size-2.75 shrink-0"
                />
                <span
                  class="truncate"
                  :title="visibleText(state.branch)"
                >{{ visibleText(state.branch) }}</span>
              </span>
              <span class="flex-1" />
              <!-- Hidden from assistive tech: inside the status region every tick would be announced. -->
              <span
                v-if="busy"
                class="shrink-0 font-mono text-11 text-(--d-faint-text) tabular-nums"
                aria-hidden="true"
                data-testid="worktree-status-elapsed"
              >{{ elapsed }}</span>
            </div>

            <!-- The command setup runs now, verbatim, then its place in the list. -->
            <p
              v-if="step"
              class="mt-1 ms-5.5 flex min-w-0 items-baseline gap-1.5 text-11.5 text-(--d-faint-text)"
              data-testid="worktree-setup-step"
            >
              <i18n-t
                keypath="worktree.setupStep"
                tag="span"
                class="min-w-0 truncate"
                scope="global"
              >
                <template #command>
                  <span
                    class="font-mono text-(--d-muted)"
                    dir="ltr"
                  >{{ stepCommand }}</span>
                </template>
                <template #index>
                  {{ step.index }}
                </template>
                <template #total>
                  {{ step.total }}
                </template>
              </i18n-t>
            </p>

            <!-- Rule 4: the first prompt waits with core; it shows here until it is sent, so the user knows it is kept. -->
            <div
              v-if="heldPrompt"
              class="mt-2 ms-5.5 flex items-start gap-1.5 rounded-7 bg-(--d-hover) px-2 py-1.5 text-12"
              data-testid="worktree-held-prompt"
            >
              <MessageSquare
                aria-hidden="true"
                class="mt-0.5 size-3 shrink-0 text-(--d-faint)"
              />
              <span class="sr-only">{{ t('worktree.heldPrompt') }}</span>
              <span class="line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap wrap-break-word">{{ heldPrompt.text }}</span>
              <span
                v-if="heldPrompt.imageCount > 0"
                class="flex shrink-0 items-center gap-1 text-11 text-(--d-faint-text)"
                data-testid="worktree-held-prompt-images"
              >
                <ImageIcon
                  aria-hidden="true"
                  class="size-3"
                />{{ t('worktree.heldImages', { n: heldPrompt.imageCount }, heldPrompt.imageCount) }}
              </span>
            </div>
            <p
              v-if="kind === 'createFailed' && state.error"
              class="mt-2 ms-5.5 max-h-24 overflow-auto rounded-7 border border-(--d-border) bg-(--d-code) px-2 py-1.5 font-mono text-11 whitespace-pre-wrap break-all text-(--d-danger-text)"
              data-testid="worktree-status-error"
            >
              {{ visibleLines(rt(state.error)) }}
            </p>
            <p
              class="mt-1.5 ms-5.5 text-11.5 text-pretty text-(--d-faint-text)"
              data-testid="worktree-status-note"
            >
              <template v-if="kind === 'settingUp'">
                {{ heldPrompt ? t('worktree.setupNote') : t('worktree.setupNoteMoved') }}
              </template>
              <template v-else-if="kind === 'setupFailed'">
                {{ heldPrompt ? t('worktree.setupFailedNote') : t('worktree.setupFailedNoteMoved') }}
              </template>
              <template v-else-if="kind === 'createFailed'">
                {{ t('worktree.createFailedNote') }}
              </template>
            </p>

            <div
              v-if="kind !== 'creating'"
              class="mt-2 ms-5.5 flex flex-wrap gap-2"
            >
              <template v-if="kind === 'settingUp'">
                <Button
                  type="button"
                  variant="outline"
                  :class="plainButton"
                  data-testid="worktree-show-setup-terminal"
                  @click="act('showSetupTerminal')"
                >
                  <SquareTerminal aria-hidden="true" />{{ t('worktree.showSetupTerminal') }}
                </Button>
                <Button
                  v-if="heldPrompt"
                  type="button"
                  :class="fillButton"
                  data-testid="worktree-send-now"
                  @click="act('sendNow')"
                >
                  <Send aria-hidden="true" />{{ t('worktree.sendNow') }}
                </Button>
              </template>
              <template v-else-if="kind === 'setupFailed'">
                <Button
                  type="button"
                  variant="outline"
                  :class="plainButton"
                  data-testid="worktree-show-setup-terminal"
                  @click="act('showSetupTerminal')"
                >
                  <SquareTerminal aria-hidden="true" />{{ t('worktree.showSetupTerminal') }}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  :class="plainButton"
                  data-testid="worktree-retry"
                  @click="act('retry')"
                >
                  <RotateCw aria-hidden="true" />{{ t('worktree.retry') }}
                </Button>
                <Button
                  v-if="heldPrompt"
                  type="button"
                  :class="fillButton"
                  data-testid="worktree-send-anyway"
                  @click="act('sendNow')"
                >
                  <Send aria-hidden="true" />{{ t('worktree.sendAnyway') }}
                </Button>
                <Button
                  v-else
                  type="button"
                  :class="fillButton"
                  data-testid="worktree-continue"
                  @click="act('sendNow')"
                >
                  <ArrowRight aria-hidden="true" />{{ t('worktree.continueWithoutSetup') }}
                </Button>
              </template>
              <template v-else>
                <Button
                  type="button"
                  variant="outline"
                  :class="plainButton"
                  data-testid="worktree-retry"
                  @click="act('retry')"
                >
                  <RotateCw aria-hidden="true" />{{ t('worktree.retry') }}
                </Button>
                <Button
                  type="button"
                  :class="fillButton"
                  data-testid="worktree-run-in-project"
                  @click="act('runInProjectFolder')"
                >
                  <Folder aria-hidden="true" />{{ t('worktree.runInProject') }}
                </Button>
              </template>
            </div>
          </div>
        </Transition>
      </div>
      <!-- The wait's live edge: a band sweeps the card's foot while git or the setup works. -->
      <Transition name="t-fade">
        <div
          v-if="busy"
          class="d-sweep-bar absolute inset-x-0 bottom-0 h-0.5 bg-(--d-hover) text-(--d-accent)"
          aria-hidden="true"
        />
      </Transition>
    </div>
  </Transition>
</template>
