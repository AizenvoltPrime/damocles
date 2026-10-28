<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { LoaderCircle } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import type { LingerResult } from '../../../preload/overlay-channels';

// Allow background work on a host that ends the user's processes at logout: the daemon enables linger for its own user, and a
// polkit refusal shows the command an admin runs. allow resolves undefined when its popup closed meanwhile.
const props = defineProps<{ hostName: string; allow: () => Promise<LingerResult | undefined> }>();
const { t } = useI18n();

const busy = ref(false);
const result = ref<LingerResult>();
const failed = ref(false);

// The user name as one POSIX shell word: an SSSD or Active Directory name may hold `\`, `$` or a space.
const shellWord = (word: string): string => (/^[A-Za-z0-9_.@%+=,-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);

async function run(): Promise<void> {
  busy.value = true;
  failed.value = false;
  try {
    const answer = await props.allow();
    if (answer) result.value = answer;
  } catch {
    failed.value = true;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div
    class="flex flex-col gap-1.5"
    data-testid="allow-background-work"
    :data-result="result?.result"
  >
    <p
      v-if="result?.result === 'enabled' || result?.result === 'alreadyEnabled'"
      role="status"
      class="text-11.5 text-(--d-success-text)"
    >
      {{ t(`remote.linger.${result.result}`, { name: hostName }) }}
    </p>
    <template v-else-if="result?.result === 'refused'">
      <p
        role="status"
        class="text-11.5"
      >
        {{ t('remote.linger.refused', { name: hostName }) }}
      </p>
      <code
        dir="ltr"
        data-testid="linger-command"
        class="self-start rounded-6 border border-(--d-border) bg-(--d-code) px-2 py-1 font-mono text-11 text-(--d-text) select-all"
      >sudo loginctl enable-linger {{ shellWord(result.user) }}</code>
    </template>
    <template v-else>
      <p
        v-if="result?.result === 'failed' || failed"
        role="alert"
        class="text-11.5 text-(--d-danger-text)"
      >
        {{ t('remote.linger.failed', { name: hostName }) }}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="allow-background-work-button"
        :disabled="busy"
        class="h-6 self-start rounded-7 border-(--d-border2) bg-(--d-card) px-2 text-11 text-(--d-text)"
        @click="run"
      >
        <LoaderCircle
          v-if="busy"
          aria-hidden="true"
          class="d-spinning size-3"
        />
        {{ t('remote.linger.allow') }}
      </Button>
    </template>
  </div>
</template>
