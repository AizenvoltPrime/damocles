<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { LoaderCircle, SquareTerminal, X } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { visibleText } from '@shared/visible-text';
import type { DamoclesShellApi } from '../../preload/shell-channels';
import { reopenFailureText } from './wsl-reopen';

// A local project in a WSL distro's file system offers to reopen it there; main remembers a dismissal per project and toasts a
// rejected reopen. In the Projects listbox, which may own only options and groups, the row's notice serves the pointer alone (its
// clicks stay out of the row): its text describes the option, and the keyboard reopens from the project's menu or from Files.
const props = defineProps<{
  api: DamoclesShellApi;
  projectKey: string;
  projectName: string;
  distro: string;
  // where it shows, for e2e and the layout: in the Projects row or at the top of Files
  place: 'row' | 'files';
  // the notice text's id, which the row's option names as its description
  textId?: string | undefined;
}>();
const inList = computed(() => props.place === 'row');
const { t } = useI18n();

const reopening = ref(false);
const failure = ref<{ code: string; text: string } | undefined>();

async function reopen(): Promise<void> {
  if (reopening.value) return;
  reopening.value = true;
  failure.value = undefined;
  try {
    const result = await props.api.reopenInWsl(props.projectKey);
    if (!result.ok) failure.value = { code: result.code, text: reopenFailureText(result, { name: props.projectName, distro: props.distro }, t) };
  } catch (error) {
    console.error('[wsl] reopening the folder in WSL failed', error);
  } finally {
    reopening.value = false;
  }
}

async function dismiss(): Promise<void> {
  failure.value = undefined;
  try {
    await props.api.dismissWslNotice(props.projectKey);
  } catch (error) {
    console.error('[wsl] hiding the notice failed', error);
    failure.value = { code: 'dismissFailed', text: t('wsl.notice.dismissFailed') };
  }
}
</script>

<template>
  <div
    :role="inList ? undefined : 'group'"
    data-testid="wsl-notice"
    :data-place="place"
    :aria-hidden="inList || undefined"
    :aria-label="inList ? undefined : t('wsl.notice.label', { name: projectName })"
    class="flex items-start gap-2 rounded-lg bg-(--d-info)/12 text-(--d-info-text)"
    :class="place === 'row' ? 'ms-8 me-1 px-2 py-1.5 text-11' : 'px-2.5 py-2 text-12'"
    @click.stop
    @contextmenu.stop
  >
    <SquareTerminal
      aria-hidden="true"
      class="mt-0.5 shrink-0"
      :class="place === 'row' ? 'size-3' : 'size-3.5'"
    />
    <div class="flex min-w-0 flex-1 flex-col items-start gap-1.5">
      <p
        :id="textId"
        class="leading-snug"
      >
        {{ t('wsl.notice.text', { distro: visibleText(distro) }) }}
      </p>
      <p
        v-if="failure"
        :role="inList ? undefined : 'alert'"
        data-testid="wsl-notice-failure"
        :data-code="failure.code"
        class="leading-snug text-(--d-danger-text)"
      >
        {{ failure.text }}
      </p>
      <!-- The row's notice is hidden from assistive technology inside the Projects listbox, which may own only options, so its
           failure is spoken from a region outside both, mounted empty before any failure fills it. -->
      <Teleport
        v-if="inList"
        to="body"
      >
        <p
          role="alert"
          data-testid="wsl-notice-failure-alert"
          :data-project-key="projectKey"
          class="sr-only"
        >
          {{ failure?.text ?? '' }}
        </p>
      </Teleport>
      <!-- A link in the narrow project row, a button at the top of Files. -->
      <Button
        type="button"
        size="sm"
        :variant="place === 'row' ? 'link' : 'outline'"
        data-testid="wsl-notice-reopen"
        class="gap-1.5 text-11 font-semibold text-(--d-info-text) [&_svg]:size-3"
        :class="place === 'row' ? 'h-auto p-0 underline-offset-2' : 'h-6 rounded-6 border-(--d-info)/40 bg-transparent px-2 hover:bg-(--d-info)/15 hover:text-(--d-info-text)'"
        :aria-busy="reopening || undefined"
        :tabindex="inList ? -1 : undefined"
        :disabled="reopening"
        @click="reopen"
      >
        <LoaderCircle
          v-if="reopening"
          aria-hidden="true"
          class="d-spinning"
        />
        <Transition
          name="t-swap"
          mode="out-in"
        >
          <span :key="reopening ? 'busy' : 'idle'">{{ reopening ? t('wsl.notice.reopening', { distro: visibleText(distro) }) : t('wsl.notice.reopen') }}</span>
        </Transition>
      </Button>
    </div>
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      data-testid="wsl-notice-dismiss"
      class="-me-0.5 -mt-0.5 size-5 shrink-0 rounded-md text-(--d-info-text) hover:bg-(--d-info)/15 [&_svg]:size-3"
      :tabindex="inList ? -1 : undefined"
      :aria-label="t('wsl.notice.dismiss', { name: projectName })"
      :title="t('wsl.notice.dismiss', { name: projectName })"
      @click="dismiss"
    >
      <X aria-hidden="true" />
    </Button>
  </div>
</template>
