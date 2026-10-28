<script setup lang="ts">
import { nextTick, onMounted, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { Eye, EyeOff } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { visibleText } from '@shared/visible-text';
import type { SshPrompt } from '../../../preload/overlay-channels';

// A secret ssh asks for, in the row of the step that waits on it; it takes focus as it appears. The parent keys it by the
// prompt, so each prompt starts empty and masked. remember: offered only when main allows it.
// cancellable: the prompt has no other Cancel nearby (the timeline's own Cancel ends the attempt)
const props = defineProps<{ prompt: Extract<SshPrompt, { kind: 'secret' }>; cancellable?: boolean }>();
const emit = defineEmits<{ answer: [answer: string, remember: boolean]; cancel: [] }>();
const { t } = useI18n();

const secret = ref('');
const remember = ref(false);
// askpass does not say whether ssh would echo a prompt, so every kind starts masked
const shown = ref(false);
const helpId = useId();
const rememberId = useId();
const root = ref<HTMLFormElement | null>(null);

onMounted(async () => {
  await nextTick();
  root.value?.querySelector<HTMLInputElement>('input')?.focus();
});

function send(): void {
  emit('answer', secret.value, props.prompt.offerRemember === true && remember.value);
  secret.value = '';
}
</script>

<template>
  <form
    ref="root"
    class="flex flex-col gap-2"
    data-testid="secret-prompt"
    @submit.prevent="send"
  >
    <span
      :id="helpId"
      dir="ltr"
      class="text-11.5 text-(--d-muted)"
    >{{ visibleText(prompt.text) }}</span>
    <span class="flex flex-wrap items-center gap-2">
      <Input
        v-model="secret"
        :type="shown ? 'text' : 'password'"
        autocomplete="off"
        spellcheck="false"
        :aria-label="t(`remote.timeline.secret.${prompt.secretKind}`)"
        :aria-describedby="helpId"
        class="h-7.5 w-72 max-w-full rounded-lg border-(--d-border2) bg-(--d-input) px-2.5 text-13 text-(--d-text) focus-visible:border-(--d-accent) focus-visible:ring-3 focus-visible:ring-(--d-accent-soft) focus-visible:ring-offset-0"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="secret-show"
        class="size-7 rounded-7 text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text) aria-pressed:text-(--d-accent)"
        :aria-label="t('remote.timeline.secret.show')"
        :title="t(shown ? 'remote.timeline.secret.hide' : 'remote.timeline.secret.show')"
        :aria-pressed="shown"
        @click="shown = !shown"
      >
        <EyeOff
          v-if="shown"
          aria-hidden="true"
          class="size-3.75"
        />
        <Eye
          v-else
          aria-hidden="true"
          class="size-3.75"
        />
      </Button>
      <Button
        type="submit"
        size="sm"
        class="h-7 rounded-7 px-3 text-11.5 font-semibold"
      >
        {{ t('remote.timeline.continue') }}
      </Button>
      <Button
        v-if="cancellable"
        type="button"
        variant="ghost"
        size="sm"
        data-testid="secret-cancel"
        class="h-7 rounded-7 px-3 text-11.5 text-(--d-muted)"
        @click="secret = ''; emit('cancel')"
      >
        {{ t('remote.timeline.cancel') }}
      </Button>
    </span>
    <span
      v-if="prompt.offerRemember"
      class="flex items-center gap-2"
    >
      <Checkbox
        :id="rememberId"
        :checked="remember"
        data-testid="secret-remember"
        class="size-3.75 shrink-0 rounded-xs border-(--d-border2) data-[state=checked]:border-(--d-accent) data-[state=checked]:bg-(--d-accent) data-[state=checked]:text-(--d-on-accent) [&_svg]:size-2.75"
        @update:checked="remember = $event"
      />
      <label
        :for="rememberId"
        class="cursor-pointer text-12 text-(--d-muted)"
      >{{ t('remote.timeline.remember') }}</label>
    </span>
  </form>
</template>
