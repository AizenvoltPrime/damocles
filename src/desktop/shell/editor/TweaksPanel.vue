<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Check, CircleAlert, LoaderCircle, Lock, RotateCcw, SlidersHorizontal, X } from 'lucide-vue-next';
import type { AcceptableValue } from 'reka-ui';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import type { TweakControl, TweaksDeclaration } from '../../../shared/types/design';
import type { DamoclesShellApi } from '../../preload/shell-channels';
import { changedControls, ensureTweaksSession, keptValue, markKept, stopLabel, tweaksSession } from './tweaks-session';

// The preview tab's Tweaks column (UI reference: Tweaks). A stop applies on the live view only, through main; Keep sends each
// changed control to the designer as its own "Keep" prompt, and only the designer's RecordDecision makes one a decision.
const props = defineProps<{
  api: DamoclesShellApi;
  tabId: string;
  declaration: TweaksDeclaration;
  // what main applied to the tab, by property
  applied: Readonly<Record<string, string>>;
  // markup is on: the live view is hidden and main refuses a change
  paused: boolean;
}>();
const emit = defineEmits<{ close: []; announce: [text: string] }>();
const { t } = useI18n();

const session = computed(() => tweaksSession(props.tabId));

// A pick shows at once; it gives way to main's state once main applied it, or on a refusal.
const pending = reactive<Record<string, string>>({});
watch(() => props.applied, (applied) => {
  for (const [property, token] of Object.entries(pending)) {
    if (applied[property] === token) delete pending[property];
  }
});

const notice = ref<{ kind: 'apply' | 'reset' | 'keep'; label?: string } | null>(null);
const resetting = ref(false);
const keeping = ref(false);
const busy = computed(() => resetting.value || keeping.value);

function shownToken(control: TweakControl): string {
  if (control.locked) return control.locked.value;
  return pending[control.property] ?? props.applied[control.property] ?? '';
}

function stopOf(control: TweakControl, token: string): { token: string; value: string } | undefined {
  return control.stops.find((stop) => stop.token === token);
}

function stopName(control: TweakControl, token: string): string {
  return stopLabel(control.property, token);
}

const changed = computed(() => changedControls(session.value, props.declaration, { ...props.applied, ...pending }));
const appliedCount = computed(() => Object.keys(props.applied).length);

async function pick(control: TweakControl, value: AcceptableValue | AcceptableValue[]): Promise<void> {
  // Pressing the pressed stop again keeps it: one property holds one applied value until Reset.
  if (typeof value !== 'string' || value === '' || control.locked || props.paused || !stopOf(control, value)) return;
  if (value === shownToken(control)) return;
  notice.value = null;
  pending[control.property] = value;
  try {
    await props.api.designTweakApply({ tabId: props.tabId, property: control.property, token: value });
  } catch (error) {
    console.error('[design preview] main refused the tweak', error);
    if (pending[control.property] === value) delete pending[control.property];
    notice.value = { kind: 'apply', label: control.label };
  }
}

async function reset(): Promise<void> {
  if (busy.value || props.paused || appliedCount.value === 0) return;
  resetting.value = true;
  notice.value = null;
  for (const property of Object.keys(pending)) delete pending[property];
  try {
    await props.api.designTweakReset(props.tabId);
    emit('announce', t('editor.designPreview.tweaks.resetDone'));
  } catch (error) {
    console.error('[design preview] the tweaks were not reset', error);
    notice.value = { kind: 'reset' };
  } finally {
    resetting.value = false;
  }
}

// One Keep per changed control, in declaration order, each its own prompt; a refusal stops the rest, which stay changed.
async function keep(): Promise<void> {
  if (busy.value || props.paused || changed.value.length === 0) return;
  keeping.value = true;
  notice.value = null;
  const sent: string[] = [];
  try {
    for (const { control, token } of changed.value) {
      try {
        await props.api.designTweakKeep({ tabId: props.tabId, tweakId: control.id, value: token });
      } catch (error) {
        console.error('[design preview] main refused the Keep', error);
        notice.value = { kind: 'keep', label: control.label };
        return;
      }
      markKept(ensureTweaksSession(props.tabId), props.declaration, control, token);
      sent.push(t('editor.designPreview.tweaks.keepLine', { label: control.label, token }));
    }
  } finally {
    keeping.value = false;
    if (sent.length > 0) emit('announce', t('editor.designPreview.tweaks.kept', { list: sent.join(', ') }));
  }
}

const keepTitle = computed(() => (changed.value.length === 0
  ? t('editor.designPreview.tweaks.keepNone')
  : t('editor.designPreview.tweaks.keepTitle', { list: changed.value.map(({ control, token }) => t('editor.designPreview.tweaks.keepLine', { label: control.label, token })).join(', ') })));

const noticeText = computed(() => {
  const current = notice.value;
  if (!current) return '';
  if (current.kind === 'apply') return t('editor.designPreview.tweaks.applyFailed', { label: current.label });
  if (current.kind === 'keep') return t('editor.designPreview.tweaks.keepFailed', { label: current.label });
  return t('editor.designPreview.tweaks.resetFailed');
});

const SEGMENT_ITEM = 'h-5.5 min-w-8 flex-auto rounded-5 px-1.5 font-mono text-11 font-normal text-(--d-muted) transition-[color,background-color,box-shadow] duration-150 hover:bg-transparent hover:text-(--d-text) focus-visible:ring-1 focus-visible:ring-(--d-accent) focus-visible:ring-offset-0 data-[state=on]:bg-(--d-design) data-[state=on]:text-(--d-on-design) disabled:opacity-100';
const SWATCH_ITEM = 'size-6.5 min-w-0 rounded-full p-0.75 transition-[box-shadow,transform] duration-150 hover:bg-transparent focus-visible:ring-2 focus-visible:ring-(--d-accent) focus-visible:ring-offset-0 data-[state=on]:shadow-[0_0_0_2px_var(--d-design)] disabled:opacity-100';
const BUTTON = 'd-press h-7 flex-1 gap-1.5 rounded-7 px-2 text-12 aria-disabled:cursor-default aria-disabled:opacity-(--d-opacity-disabled) [&_svg]:size-3.5';
</script>

<template>
  <aside
    data-testid="design-tweaks"
    :aria-label="t('editor.designPreview.tweaks.panel')"
    :data-paused="paused || undefined"
    class="flex min-h-0 flex-col border-s border-(--d-border) bg-(--d-panel)"
  >
    <header class="flex flex-none items-center gap-2 border-b border-(--d-border) py-2 ps-3 pe-1.5">
      <span
        aria-hidden="true"
        class="flex size-6 flex-none items-center justify-center rounded-7 bg-[color-mix(in_srgb,var(--d-design)_16%,transparent)] text-(--d-design)"
      >
        <SlidersHorizontal class="size-3.5" />
      </span>
      <div class="min-w-0 flex-1">
        <h2 class="text-12.5/tight font-semibold text-(--d-text)">
          {{ t('editor.designPreview.tweaks.title') }}
        </h2>
        <p class="truncate text-11 text-(--d-faint-text)">
          {{ t(paused ? 'editor.designPreview.tweaks.paused' : 'editor.designPreview.tweaks.subtitle') }}
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        data-testid="design-tweaks-close"
        :aria-label="t('editor.designPreview.tweaks.close')"
        :title="t('editor.designPreview.tweaks.close')"
        class="d-press size-6.5 rounded-7 text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text) focus-visible:ring-1 focus-visible:ring-(--d-accent) focus-visible:ring-offset-0 [&_svg]:size-3.5"
        @click="emit('close')"
      >
        <X aria-hidden="true" />
      </Button>
    </header>

    <ul
      class="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-3"
      :class="paused && 'opacity-(--d-opacity-disabled)'"
    >
      <li
        v-for="control in declaration.controls"
        :key="control.id"
        data-testid="design-tweak"
        :data-tweak="control.id"
        :data-locked="control.locked ? true : undefined"
        class="flex flex-col gap-1.5"
      >
        <div class="flex min-w-0 items-baseline gap-2">
          <span
            :id="`design-tweak-${tabId}-${control.id}`"
            class="min-w-0 flex-1 truncate text-12 font-medium text-(--d-text)"
            :title="control.property"
          >{{ control.label }}</span>
          <span
            v-if="control.locked"
            data-testid="design-tweak-lock"
            :title="t('editor.designPreview.tweaks.lockedTitle', { id: control.locked.decisionId })"
            class="inline-flex h-4.5 flex-none items-center gap-1 rounded-full border border-[color-mix(in_srgb,var(--d-design)_40%,var(--d-border))] bg-[color-mix(in_srgb,var(--d-design)_10%,transparent)] px-1.5 font-mono text-10.5 text-(--d-design-text)"
          >
            <Lock
              aria-hidden="true"
              class="size-2.75"
            /><span class="sr-only">{{ t('editor.designPreview.tweaks.locked', { id: control.locked.decisionId }) }}</span><span aria-hidden="true">{{ control.locked.decisionId }}</span>
          </span>
          <span
            v-else-if="shownToken(control)"
            data-testid="design-tweak-value"
            dir="ltr"
            class="flex min-w-0 flex-none items-center gap-1 font-mono text-10.5 text-(--d-faint-text)"
          >
            <Check
              v-if="keptValue(session, declaration, control) === shownToken(control)"
              aria-hidden="true"
              class="size-3 text-(--d-success-text)"
            />{{ stopOf(control, shownToken(control))?.value ?? shownToken(control) }}
          </span>
        </div>
        <ToggleGroup
          type="single"
          :model-value="shownToken(control)"
          :disabled="control.locked !== null || paused || busy"
          :aria-labelledby="`design-tweak-${tabId}-${control.id}`"
          data-testid="design-tweak-stops"
          :data-kind="control.kind"
          :class="control.kind === 'swatch'
            ? 'flex-wrap justify-start gap-1.5'
            : 'flex-wrap justify-start gap-0.5 rounded-7 border border-(--d-border) bg-(--d-bg) p-0.5'"
          @update:model-value="(value: AcceptableValue | AcceptableValue[]) => pick(control, value)"
        >
          <ToggleGroupItem
            v-for="stop in control.stops"
            :key="stop.token"
            :value="stop.token"
            data-testid="design-tweak-stop"
            :data-token="stop.token"
            :aria-label="t('editor.designPreview.tweaks.stop', { label: control.label, stop: stopName(control, stop.token), value: stop.value })"
            :title="`${stop.token} · ${stop.value}`"
            :class="control.kind === 'swatch' ? SWATCH_ITEM : SEGMENT_ITEM"
          >
            <span
              v-if="control.kind === 'swatch'"
              aria-hidden="true"
              class="block size-full rounded-full shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--d-text)_18%,transparent)]"
              :style="{ background: stop.value }"
            />
            <span
              v-else
              dir="ltr"
            >{{ stopName(control, stop.token) }}</span>
          </ToggleGroupItem>
        </ToggleGroup>
        <span
          v-if="control.kind === 'swatch' && shownToken(control)"
          dir="ltr"
          class="truncate font-mono text-10.5 text-(--d-muted)"
        >{{ shownToken(control) }}</span>
      </li>
    </ul>

    <!-- Reset and Keep are aria-disabled, not disabled, so the one pressed keeps focus while its request runs. -->
    <footer class="flex flex-none flex-col gap-1.5 border-t border-(--d-border) p-2.5">
      <Transition name="t-tuck">
        <p
          v-if="notice"
          role="status"
          data-testid="design-tweaks-notice"
          :data-notice="notice.kind"
          class="flex items-start gap-1 text-11.5 text-(--d-danger-text)"
        >
          <CircleAlert
            aria-hidden="true"
            class="mt-px size-3.25 flex-none"
          />{{ noticeText }}
        </p>
      </Transition>
      <div class="flex gap-1.5">
        <Button
          variant="ghost"
          data-testid="design-tweaks-reset"
          :class="cn(BUTTON, 'border border-(--d-border) text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text) focus-visible:ring-1 focus-visible:ring-(--d-accent) focus-visible:ring-offset-0 aria-disabled:hover:bg-transparent aria-disabled:hover:text-(--d-muted)')"
          :title="t('editor.designPreview.tweaks.resetTitle')"
          :aria-disabled="busy || paused || appliedCount === 0 || undefined"
          :aria-busy="resetting || undefined"
          @click="reset"
        >
          <LoaderCircle
            v-if="resetting"
            aria-hidden="true"
            class="d-spinning"
          />
          <RotateCcw
            v-else
            aria-hidden="true"
          />{{ t('editor.designPreview.tweaks.reset') }}
        </Button>
        <Button
          data-testid="design-tweaks-keep"
          :class="cn(BUTTON, 'bg-(--d-design) font-medium text-(--d-on-design) hover:bg-[color-mix(in_srgb,var(--d-design)_88%,var(--d-text))] focus-visible:ring-2 focus-visible:ring-(--d-accent) focus-visible:ring-offset-1 focus-visible:ring-offset-(--d-panel) aria-disabled:hover:bg-(--d-design)')"
          :title="keepTitle"
          :aria-disabled="busy || paused || changed.length === 0 || undefined"
          :aria-busy="keeping || undefined"
          @click="keep"
        >
          <LoaderCircle
            v-if="keeping"
            aria-hidden="true"
            class="d-spinning"
          />
          <Check
            v-else
            aria-hidden="true"
          />{{ changed.length > 1 ? t('editor.designPreview.tweaks.keepMany', { n: changed.length }) : t('editor.designPreview.tweaks.keep') }}
        </Button>
      </div>
    </footer>
  </aside>
</template>
