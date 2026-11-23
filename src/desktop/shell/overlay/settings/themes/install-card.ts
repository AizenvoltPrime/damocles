// The install card of the Settings modal. Main holds one card open for as long as the modal shows, so the modal owns it
// here: no section, sub-page or scope tab the user moves to unmounts it.
import { inject, onScopeDispose, provide, ref, shallowRef, type InjectionKey, type Ref, type ShallowRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { isolated } from '@shared/bidi-isolate';
import type { ThemeInstallAnswer, ThemeInstallPreview } from '@shared/themes/install';
import type { DamoclesOverlayApi } from '../../../../preload/overlay-channels';
import { answerOf } from '../../popup-answer';
import { failureText } from './theme-text';

export interface InstallCard {
  readonly preview: Readonly<ShallowRef<ThemeInstallPreview | undefined>>;
  // the commit main is carrying out
  readonly busy: Readonly<Ref<boolean>>;
  // why the install did not land, in the UI's language
  readonly failure: Readonly<Ref<string | undefined>>;
  // each running flash check's progress, by the wallpaper's sha256
  readonly progress: Readonly<ShallowRef<Readonly<Record<string, number>>>>;
  // what the card's end has to say (installed, expired); the gallery shows it as its toast and clears it
  readonly notice: ShallowRef<string | undefined>;
  /** The card of a start this page made (Import, Install from link, the store), which main answered with its preview. */
  open(preview: ThemeInstallPreview): void;
  answer(answer: ThemeInstallAnswer): Promise<void>;
  allowFlash(sha256: string): Promise<void>;
  /** The card of a start the user gave up on: nothing shows, and main frees its slot. */
  drop(installId: string): Promise<void>;
}

const CARD: InjectionKey<InstallCard> = Symbol('themeInstallCard');

export function provideInstallCard(api: DamoclesOverlayApi): InstallCard {
  const { t } = useI18n();
  const preview = shallowRef<ThemeInstallPreview>();
  const busy = ref(false);
  const failure = ref<string>();
  const progress = shallowRef<Readonly<Record<string, number>>>({});
  const notice = shallowRef<string>();
  const failed = (err: unknown): undefined => {
    failure.value = failureText(t, err, 'install');
    return undefined;
  };

  function open(next: ThemeInstallPreview): void {
    failure.value = undefined;
    progress.value = {};
    preview.value = next;
  }

  // Main holds the open card. It is read when the modal mounts and whenever main says it changed, so a card main opened
  // before this ran shows, and its newest preview wins whatever order the pushes arrived in.
  let reads = 0;
  async function read(): Promise<void> {
    const turn = ++reads;
    const current = await answerOf(api.installCurrent()).catch(failed);
    if (!current || turn !== reads) return;
    const shown = preview.value;
    if (current.preview) {
      if (shown?.installId === current.preview.installId) preview.value = current.preview;
      else if (!busy.value) open(current.preview);
    } else if (shown && current.expired === shown.installId) {
      preview.value = undefined;
      notice.value = t('settingsHost.themes.toast.installExpired');
    }
  }
  onScopeDispose(api.onInstallChanged(() => void read()));
  void read();
  onScopeDispose(api.onInstallProgress(({ installId, sha256, fraction }) => {
    if (preview.value?.installId === installId) progress.value = { ...progress.value, [sha256]: fraction };
  }));

  const card: InstallCard = {
    preview,
    busy,
    failure,
    progress,
    notice,
    open,
    async answer(answer) {
      const shown = preview.value;
      if (!shown || busy.value) return;
      if (answer.choice === 'cancel') {
        preview.value = undefined;
        await api.installCancel(shown.installId).catch((err: unknown) => failureText(t, err, 'install'));
        return;
      }
      busy.value = true;
      failure.value = undefined;
      try {
        const result = await answerOf(api.installCommit({ installId: shown.installId, useArrangement: answer.useArrangement, ...(answer.onClash ? { onClash: answer.onClash } : {}) }));
        if (!result) return;
        if (!result.ok) {
          failure.value = result.error;
          return;
        }
        preview.value = undefined;
        const { installed } = result;
        const lines = [t(shown.store?.update ? 'settingsHost.themes.toast.updated' : 'settingsHost.themes.toast.installed', { name: isolated(installed.name) })];
        if (answer.useArrangement) lines.push(t('settingsHost.themes.toast.installedArrangement'));
        if (installed.keptCopy) lines.push(t('settingsHost.themes.toast.keptCopy', { name: isolated(installed.keptCopy.name) }));
        notice.value = lines.join(' ');
      } catch (err) {
        failed(err);
      } finally {
        busy.value = false;
      }
    },
    // Main and core check that the file is a flagged wallpaper of the open card; the card updates from core.
    async allowFlash(sha256) {
      const shown = preview.value;
      if (!shown) return;
      failure.value = undefined;
      await answerOf(api.installAllowFlash(shown.installId, sha256)).catch(failed);
    },
    async drop(installId) {
      if (preview.value?.installId === installId) preview.value = undefined;
      await api.installCancel(installId).catch((err: unknown) => failureText(t, err, 'install'));
    },
  };
  provide(CARD, card);
  return card;
}

export function useInstallCard(): InstallCard {
  const card = inject(CARD, null);
  if (!card) throw new Error('useInstallCard called outside the overlay settings');
  return card;
}
