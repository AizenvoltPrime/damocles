import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { ElicitationRequest, ElicitationResult } from '@shared/types/elicitation';

export const useElicitationStore = defineStore('elicitation', () => {
  const pendingElicitations = ref<ElicitationRequest[]>([]);

  function addElicitation(request: ElicitationRequest): void {
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
