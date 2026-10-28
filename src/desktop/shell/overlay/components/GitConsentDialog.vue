<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { ArrowRight, KeyRound, Laptop, TriangleAlert } from 'lucide-vue-next';
import HostBadge from '@/components/HostBadge.vue';
import type { GitCredentialConsentChoice, OverlayAnswer, OverlayRequest } from '../../../preload/overlay-channels';
import OverlayDialog, { type DialogButton } from './OverlayDialog.vue';

// A remote host's git asks for a credential this computer's credential manager holds: the first use per pair of hosts asks.
// Deny is focused first and is what Escape and the scrim choose, so nothing grants the credential but a click on a grant.
const props = defineProps<{ request: Extract<OverlayRequest, { kind: 'gitCredentialConsent' }> }>();
const emit = defineEmits<{ answer: [answer: OverlayAnswer] }>();
const { t } = useI18n();

const CHOICES: readonly GitCredentialConsentChoice[] = ['deny', 'always', 'once'];
const DENY = 0;
const buttons = computed((): DialogButton[] => [
  { label: t('gitConsent.deny'), variant: 'plain', testId: 'git-consent-deny' },
  { label: t('gitConsent.always', { host: props.request.hostName }), variant: 'plain', testId: 'git-consent-always' },
  { label: t('gitConsent.once'), variant: 'fill', testId: 'git-consent-once' },
]);
</script>

<template>
  <OverlayDialog
    severity="accent"
    :icon="KeyRound"
    :title="t('gitConsent.title', { host: request.hostName, credentialHost: request.credentialHost })"
    :message="t('gitConsent.body', { host: request.hostName })"
    :buttons="buttons"
    :initial-focus="DENY"
    :cancel-index="DENY"
    wide
    test-id="git-consent"
    @choose="emit('answer', { kind: 'gitCredentialConsent', choice: CHOICES[$event]! })"
  >
    <p
      class="flex min-w-0 flex-wrap items-center gap-1.5 text-12 text-(--d-muted)"
      data-testid="git-consent-hosts"
    >
      <span class="inline-flex items-center gap-1 font-mono text-(--d-text)">
        <Laptop
          aria-hidden="true"
          class="size-3.25 text-(--d-muted)"
        />
        {{ request.credentialHost }}
      </span>
      <ArrowRight
        aria-hidden="true"
        class="size-3 text-(--d-faint)"
      />
      <HostBadge
        :name="request.hostName"
        :tone="request.hostColor"
        data-testid="git-consent-host"
        :data-tone="request.hostColor ?? 'none'"
      />
    </p>
    <p
      v-if="request.targetHelper"
      data-testid="git-consent-helper-warning"
      class="flex gap-2 rounded-8 bg-(--d-warning)/12 px-2.5 py-2 text-12 text-(--d-warning-text)"
    >
      <TriangleAlert
        aria-hidden="true"
        class="mt-0.5 size-3.5 shrink-0"
      />
      <span>{{ t('gitConsent.helperWarning', { host: request.hostName }) }}</span>
    </p>
  </OverlayDialog>
</template>
