<script setup lang="ts">
import { ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { InstallFolderResult, RemoteBrowseResult } from '../../../preload/overlay-channels';
import RemoteFolderBrowser from './RemoteFolderBrowser.vue';

// A host's install folder typed as a path on the target (absolute or ~-prefixed), or chosen in its folder browser while it is
// connected; main checks it again before saving.
const props = defineProps<{
  current?: string | undefined;
  // undefined: the dialog is closing
  save: (folder: string | null) => Promise<InstallFolderResult | undefined>;
  hostName?: string | undefined;
  // the connected host's folders; absent: the path is typed only
  browse?: ((path?: string) => Promise<RemoteBrowseResult | undefined>) | undefined;
}>();
const emit = defineEmits<{ saved: [] }>();
const { t } = useI18n();

const value = ref(props.current ?? '');
// invalid: main refused the path; failed: the save itself failed
const problem = ref<'invalid' | 'failed' | undefined>();
const saving = ref(false);
const errorId = useId();
const browsing = ref(false);

function picked(folder: string): void {
  browsing.value = false;
  value.value = folder;
  void commit(folder);
}

async function commit(folder: string | null): Promise<void> {
  saving.value = true;
  let result: InstallFolderResult | undefined;
  try {
    result = await props.save(folder);
  } catch {
    problem.value = 'failed';
    return;
  } finally {
    saving.value = false;
  }
  if (!result) return;
  problem.value = result.ok ? undefined : 'invalid';
  if (result.ok) emit('saved');
}
</script>

<template>
  <!-- The browser sits outside the form, so Enter in its filter never submits the path box. -->
  <div class="flex flex-col gap-2">
    <form
      class="flex flex-wrap items-center gap-2"
      data-testid="install-folder-form"
      @submit.prevent="commit(value.trim())"
    >
      <Input
        v-model="value"
        autocomplete="off"
        spellcheck="false"
        :aria-label="t('remote.installFolder.label')"
        :aria-invalid="problem === 'invalid' ? 'true' : undefined"
        :aria-describedby="problem ? errorId : undefined"
        :placeholder="t('remote.installFolder.placeholder')"
        class="h-7.5 w-72 max-w-full rounded-lg border-(--d-border2) bg-(--d-input) px-2.5 font-mono text-12 text-(--d-text) focus-visible:border-(--d-accent) focus-visible:ring-3 focus-visible:ring-(--d-accent-soft) focus-visible:ring-offset-0"
        :class="problem === 'invalid' && 'border-(--d-danger)'"
      />
      <Button
        type="submit"
        size="sm"
        class="h-7 rounded-7 px-2.5 text-11 font-semibold"
        :disabled="saving || value.trim() === ''"
      >
        {{ t('remote.installFolder.save') }}
      </Button>
      <Button
        v-if="browse"
        type="button"
        variant="outline"
        size="sm"
        data-testid="install-folder-browse"
        class="h-7 rounded-7 border-(--d-border2) bg-(--d-card) px-2.5 text-11"
        :disabled="saving"
        :aria-expanded="browsing"
        @click="browsing = !browsing"
      >
        {{ t('remote.installFolder.browse') }}
      </Button>
      <Button
        v-if="current !== undefined"
        type="button"
        variant="ghost"
        size="sm"
        class="h-7 rounded-7 px-2.5 text-11 text-(--d-muted)"
        :disabled="saving"
        @click="commit(null)"
      >
        {{ t('remote.installFolder.default') }}
      </Button>
    </form>
    <div
      v-if="browse && browsing"
      class="flex h-80 flex-col overflow-hidden rounded-10 border border-(--d-border) bg-(--d-card) pt-2"
      data-testid="install-folder-browser"
    >
      <RemoteFolderBrowser
        :host-name="hostName ?? ''"
        :recent-folders="[]"
        :browse="browse"
        :pick="{ mode: 'folder', buttonLabel: t('remote.installFolder.useFolder') }"
        @pick="picked"
        @cancel="browsing = false"
      />
    </div>
    <span
      v-if="problem"
      :id="errorId"
      role="alert"
      class="text-11.5 text-(--d-danger-text)"
    >{{ t(`remote.installFolder.${problem}`) }}</span>
  </div>
</template>
