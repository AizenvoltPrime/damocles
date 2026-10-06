<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, shallowRef } from 'vue';
import type { DamoclesOverlayApi, OverlayAnswer, OverlayRequest } from '../../preload/overlay-channels';
import { applyShellLocale } from '../i18n';
import ContextMenu from './components/ContextMenu.vue';
import ConfirmDialog from './components/ConfirmDialog.vue';
import MessageDialog from './components/MessageDialog.vue';
import NotificationCenter from './components/NotificationCenter.vue';
import TagPicker from './components/TagPicker.vue';
import OverlaySettings from './settings/OverlaySettings.vue';
import type { OverlaySettingsBridge } from './settings/overlay-bridge';

const props = defineProps<{ api: DamoclesOverlayApi; settingsBridge: OverlaySettingsBridge }>();

// In arrival order; the last one is on top and receives Escape.
const open = shallowRef<ReadonlyArray<{ readonly id: string; readonly request: OverlayRequest }>>([]);

function close(id: string): boolean {
  const before = open.value.length;
  open.value = open.value.filter((entry) => entry.id !== id);
  return open.value.length !== before;
}

// Answers held while their popup plays its exit; main hides the overlay on an answer, which would cut the exit short.
const leaving = new Map<string, OverlayAnswer>();

// Answers go back only for a request main sent and that is still open, so each request is answered at most once.
function answer(id: string, value: OverlayAnswer): void {
  const entry = open.value.find((candidate) => candidate.id === id);
  if (!entry || !close(id)) return;
  // The settings modal has already played its own exit when it reports closed.
  if (entry.request.kind === 'settings') props.api.answer(id, value);
  else leaving.set(id, value);
}

// A popup on its way out is already answered: it takes no input and is gone for assistive technology.
function onBeforeLeave(element: Element): void {
  element.setAttribute('inert', '');
  element.setAttribute('aria-hidden', 'true');
}

function onAfterLeave(element: Element): void {
  const id = (element as HTMLElement).dataset.overlayId;
  const value = id === undefined ? undefined : leaving.get(id);
  if (id === undefined || value === undefined) return;
  leaving.delete(id);
  props.api.answer(id, value);
}

// The settings modal and the dialogs take Escape through the overlay stack: a search query clears first, and a dialog
// above the modal cancels without closing it.
const OWN_ESCAPE: ReadonlySet<OverlayRequest['kind']> = new Set(['settings', 'confirm', 'message']);

function onKeydown(event: KeyboardEvent): void {
  const top = open.value[open.value.length - 1];
  if (event.key !== 'Escape' || !top || OWN_ESCAPE.has(top.request.kind)) return;
  event.preventDefault();
  answer(top.id, { kind: 'dismissed' });
}

const stops: Array<() => void> = [];
onMounted(async () => {
  stops.push(props.api.onRequest((id, request) => {
    open.value = [...open.value, { id, request }];
    // The acknowledgement tells main the request is on screen, so it goes out once Vue has rendered it.
    void nextTick(() => {
      if (open.value.some((entry) => entry.id === id)) props.api.ack(id);
    });
  }));
  stops.push(props.api.onCancel((id) => void close(id)));
  // Subscribed before the first read, so a language change between the two is not lost.
  stops.push(props.api.onState((state) => applyShellLocale(state.locale)));
  window.addEventListener('keydown', onKeydown);
  applyShellLocale((await props.api.getState()).locale);
});
onBeforeUnmount(() => {
  for (const stop of stops) stop();
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div class="h-full">
    <TransitionGroup
      name="overlay-pop"
      @before-leave="onBeforeLeave"
      @after-leave="onAfterLeave"
    >
      <template
        v-for="entry in open"
        :key="entry.id"
      >
        <div
          v-if="entry.request.kind === 'settings'"
          :key="entry.id"
          :data-overlay-id="entry.id"
        >
          <OverlaySettings
            :api="api"
            :bridge="settingsBridge"
            :generation="entry.request.generation"
            :section="entry.request.section"
            :account="entry.request.account"
            @closed="answer(entry.id, { kind: 'settings', closed: true })"
          />
        </div>
        <ConfirmDialog
          v-else-if="entry.request.kind === 'confirm'"
          :key="entry.id"
          :data-overlay-id="entry.id"
          :request="entry.request"
          @answer="answer(entry.id, $event)"
        />
        <MessageDialog
          v-else-if="entry.request.kind === 'message'"
          :key="entry.id"
          :data-overlay-id="entry.id"
          :request="entry.request"
          @answer="answer(entry.id, $event)"
        />
        <div
          v-else
          :key="entry.id"
          :data-overlay-id="entry.id"
          data-testid="overlay-backdrop"
          class="fixed inset-0"
          @click.self="answer(entry.id, { kind: 'dismissed' })"
          @contextmenu.self.prevent="answer(entry.id, { kind: 'dismissed' })"
        >
          <ContextMenu
            v-if="entry.request.kind === 'menu'"
            :request="entry.request"
            @answer="answer(entry.id, $event)"
          />
          <NotificationCenter
            v-else-if="entry.request.kind === 'notifications'"
            :api="api"
            :request="entry.request"
            @answer="answer(entry.id, $event)"
          />
          <TagPicker
            v-else-if="entry.request.kind === 'tagPicker'"
            :request="entry.request"
            @answer="answer(entry.id, $event)"
          />
        </div>
      </template>
    </TransitionGroup>
  </div>
</template>
