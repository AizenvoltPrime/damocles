<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { DamoclesShellApi } from '../../preload/shell-channels';
import { enterPage } from './page-focus';

// The page view's stop in the shell's tab order, under the view main lays over the stage: focus on it moves into the view.
// shows: the tab's own state says a page can show; main still decides whether its view does.
const props = defineProps<{ api: Pick<DamoclesShellApi, 'focusPage'>; tabId: string; shows: boolean }>();
const { t } = useI18n();

function enter(): void {
  void enterPage(props.api, props.tabId);
}

// A focus the shell page restores as it regains focus has no relatedTarget; only a move within the shell enters the page.
function onFocus(event: FocusEvent): void {
  if (event.relatedTarget !== null) enter();
}

// While the page does not show, focus stays here; Enter or Space tries again once it does.
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  enter();
}
</script>

<template>
  <!-- No shadcn part is a focus stop for a native view; this one draws only its focus ring. -->
  <div
    role="button"
    tabindex="0"
    :aria-label="t('editor.enterPage')"
    :aria-disabled="shows ? undefined : 'true'"
    data-testid="page-stand-in"
    class="absolute inset-0 rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-(--d-accent) focus-visible:ring-inset"
    @focus="onFocus"
    @keydown="onKeydown"
  />
</template>
