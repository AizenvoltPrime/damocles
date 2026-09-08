import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { ElicitationRequest, ElicitationResult } from '@shared/types/elicitation';

export const useElicitationStore = defineStore('elicitation', () => {
  const pendingElicitations = ref<ElicitationRequest[]>([]);

  function addElicitation(request: ElicitationRequest): void {
    // The extension re-posts every pending prompt when the webview reports ready, so an id this queue
    // already holds is that same request arriving again, not a second one.
    if (pendingElicitations.value.some(e => e.elicitationId === request.elicitationId)) return;
    pendingElicitations.value = [...pendingElicitations.value, request];
  }

  function removeElicitation(elicitationId: string): void {
    pendingElicitations.value = pendingElicitations.value.filter(
      e => e.elicitationId !== elicitationId
    );
  }

  function answerElicitation(elicitationId: string, _result: ElicitationResult): void {
    removeElicitation(elicitationId);
  }

  function $reset() {
    pendingElicitations.value = [];
  }

  return {
    pendingElicitations,
    addElicitation,
    removeElicitation,
    answerElicitation,
    $reset,
  };
});
