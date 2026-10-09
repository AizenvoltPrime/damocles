<script setup lang="ts">
import { computed, onBeforeUnmount, onScopeDispose, ref, shallowRef, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import { ArrowDownToLine, Check, CircleAlert, Clock, Copy, ExternalLink, LoaderCircle, PowerOff, RefreshCw, RotateCw, ScrollText } from 'lucide-vue-next';
import SettingsRow from '@/components/settings/SettingsRow.vue';
import SettingButton from '@/components/settings/controls/SettingButton.vue';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { formatClock, formatDateTime } from '@/utils/clock';
import { canCheck, type UpdateSnapshot, type UpdateState, type VersionInfo } from '../../../preload/updates';
import { updateTone, type UpdateTone } from '../../update-view';
import { useDesktopPrefs } from './desktop-prefs';
import WhatsNew from './WhatsNew.vue';

// How long Copy version info shows "Copied".
const COPIED_MS = 1600;
// Product names, the same in every language.
const APP_NAME = 'Damocles';
const OS_NAMES: Readonly<Record<VersionInfo['platform'], string>> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

// The chip's text and tint colour (style.css .d-tone-*), so the tint never derives from the darker text shade.
const TONE_CLASSES: Readonly<Record<UpdateTone, string>> = {
  neutral: 'd-tone-muted',
  accent: 'd-tone-accent',
  success: 'd-tone-success',
  danger: 'd-tone-danger',
};

const STATUS_ICONS: Readonly<Record<UpdateState['kind'], Component>> = {
  disabled: PowerOff,
  idle: Clock,
  checking: LoaderCircle,
  upToDate: Check,
  available: ExternalLink,
  downloading: ArrowDownToLine,
  ready: RotateCw,
  restarting: RotateCw,
  error: CircleAlert,
};

const { t, locale } = useI18n();
const { api } = useDesktopPrefs();

const info = shallowRef<VersionInfo | null>(null);
const snapshot = shallowRef<UpdateSnapshot | null>(null);
// Subscribed before the first read, so a change between the two is not lost; a push is always the newer state.
onScopeDispose(api.onUpdate((next) => {
  snapshot.value = next;
}));
void api.getUpdate().then((first) => {
  if (!snapshot.value) snapshot.value = first;
});
void api.getVersionInfo().then((loaded) => {
  info.value = loaded;
});

const state = computed(() => snapshot.value?.state ?? null);
const title = computed(() => (info.value ? t('settingsHost.about.title', { app: APP_NAME, version: info.value.version }) : undefined));
const platformLine = computed(() => (info.value
  ? t('settingsHost.about.platformLine', { os: OS_NAMES[info.value.platform], arch: info.value.arch })
  : undefined));

const statusLabel = computed(() => {
  const current = state.value;
  if (!current) return '';
  return current.kind === 'downloading'
    ? t('settingsHost.about.status.downloading', { percent: current.percent })
    : t(`settingsHost.about.status.${current.kind}`);
});

const detail = computed(() => {
  const current = state.value;
  if (!current) return '';
  switch (current.kind) {
    case 'available':
    case 'downloading':
    case 'restarting':
      return t(`settingsHost.about.detail.${current.kind}`, { version: current.version });
    case 'ready':
      return t(snapshot.value?.platform === 'linux' ? 'settingsHost.about.detail.readyLinux' : 'settingsHost.about.detail.ready', { version: current.version });
    case 'error':
      return t('settingsHost.about.detail.error', { reason: current.reason });
    default:
      return t(`settingsHost.about.detail.${current.kind}`);
  }
});

const lastChecked = computed(() => {
  const at = snapshot.value?.lastCheckedAt ?? null;
  if (at === null) return t('settingsHost.about.neverChecked');
  const today = new Date(at).toDateString() === new Date().toDateString();
  return t('settingsHost.about.lastChecked', { time: today ? formatClock(at, locale.value) : formatDateTime(at, locale.value) });
});

// The update main offers, whose feed notes What's new lists first.
const pending = computed(() => {
  const current = state.value;
  return current?.kind === 'ready' || current?.kind === 'restarting' || current?.kind === 'available' ? { version: current.version, notes: current.notes } : null;
});

const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
async function copyInfo(): Promise<void> {
  await api.copyVersionInfo();
  copied.value = true;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copied.value = false;
  }, COPIED_MS);
}
onBeforeUnmount(() => clearTimeout(copiedTimer));
</script>

<template>
  <SettingsRow
    id="about-version"
    class="about-card"
    :label="title"
    :description="platformLine"
  >
    <template #label-extra>
      <Transition
        name="about-swap"
        mode="out-in"
      >
        <Badge
          v-if="state"
          :key="state.kind"
          variant="tone"
          class="about-chip"
          :class="TONE_CLASSES[updateTone(state)]"
          :data-state="state.kind"
          data-testid="about-update-status"
        >
          <Progress
            v-if="state.kind === 'downloading'"
            :model-value="state.percent"
            :aria-label="statusLabel"
            class="about-chip-fill"
          />
          <component
            :is="STATUS_ICONS[state.kind]"
            aria-hidden="true"
            class="about-chip-icon size-3"
            :class="state.kind === 'checking' || state.kind === 'restarting' ? 'd-spinning' : ''"
          />
          {{ statusLabel }}
        </Badge>
      </Transition>
    </template>
    <SettingButton
      data-testid="about-copy"
      @click="copyInfo"
    >
      <component
        :is="copied ? Check : Copy"
        aria-hidden="true"
        class="size-3"
      />
      <span aria-live="polite">{{ copied ? t('settingsHost.about.copied') : t('settingsHost.about.copy') }}</span>
    </SettingButton>
    <SettingButton
      data-testid="about-check"
      :disabled="!state || !canCheck(state)"
      @click="api.checkForUpdates()"
    >
      <RefreshCw
        aria-hidden="true"
        class="size-3"
        :class="state?.kind === 'checking' ? 'd-spinning' : ''"
      />
      {{ t('settingsHost.about.check') }}
    </SettingButton>
    <template #expand>
      <div class="about-body">
        <dl
          v-if="info"
          class="about-runtimes"
          :aria-label="t('settingsHost.about.runtimes')"
          data-testid="about-runtimes"
        >
          <div>
            <dt>Electron</dt>
            <dd>{{ info.electron }}</dd>
          </div>
          <div>
            <dt>Chromium</dt>
            <dd>{{ info.chromium }}</dd>
          </div>
          <div>
            <dt>Node</dt>
            <dd>{{ info.node }}</dd>
          </div>
        </dl>
        <div
          v-if="state"
          class="about-status"
        >
          <div class="about-status-text">
            <div aria-live="polite">
              <Transition
                name="about-fade"
                mode="out-in"
              >
                <p
                  :key="state.kind"
                  class="about-detail"
                  data-testid="about-update-detail"
                >
                  {{ detail }}
                </p>
              </Transition>
            </div>
            <p
              v-if="state.kind !== 'disabled'"
              class="about-last"
              data-testid="about-last-checked"
            >
              {{ lastChecked }}
            </p>
          </div>
          <div class="about-actions">
            <SettingButton
              v-if="state.kind === 'error'"
              data-testid="about-show-log"
              @click="api.showUpdateLog()"
            >
              <ScrollText
                aria-hidden="true"
                class="size-3"
              />
              {{ t('settingsHost.about.showLog') }}
            </SettingButton>
            <SettingButton
              v-else-if="state.kind === 'ready' || state.kind === 'restarting'"
              variant="primary"
              data-testid="about-restart"
              :disabled="state.kind === 'restarting'"
              @click="api.restartToUpdate()"
            >
              <RotateCw
                aria-hidden="true"
                class="size-3"
              />
              {{ state.kind === 'restarting' ? t('settingsHost.about.restarting') : t('settingsHost.about.restart') }}
            </SettingButton>
            <SettingButton
              v-else-if="state.kind === 'available'"
              variant="primary"
              data-testid="about-release-page"
              @click="api.openReleasePage()"
            >
              <ExternalLink
                aria-hidden="true"
                class="size-3"
              />
              {{ t('settingsHost.about.openReleasePage') }}
            </SettingButton>
          </div>
        </div>
      </div>
    </template>
  </SettingsRow>
  <SettingsRow
    id="about-whats-new"
    class="about-whats-new"
  >
    <template #expand>
      <WhatsNew :pending="pending" />
    </template>
  </SettingsRow>
</template>
