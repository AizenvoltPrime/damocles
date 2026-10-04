import { inject, onScopeDispose, provide, shallowRef, type InjectionKey, type ShallowRef } from 'vue';
import { useSettingWritesStore } from '@/components/settings/settings-writes';
import type { DamoclesOverlayApi, OverlayPrefs } from '../../../preload/overlay-channels';

/** The desktop-only damocles.desktop.* settings, which main reads and writes at user scope (C6 prefs:get / prefs:set). */
export interface DesktopPrefs {
  readonly values: ShallowRef<Readonly<Record<string, unknown>>>;
  /** undefined until main's first read answers. */
  readonly languageAtLaunch: ShallowRef<OverlayPrefs['languageAtLaunch'] | undefined>;
  /** Shows the value at once and reverts it if main refuses the write, like every other row (M7). */
  set(key: string, value: unknown): void;
  readonly api: DamoclesOverlayApi;
}

const PREFS: InjectionKey<DesktopPrefs> = Symbol('desktopPrefs');

export function provideDesktopPrefs(api: DamoclesOverlayApi): DesktopPrefs {
  const values = shallowRef<Readonly<Record<string, unknown>>>({});
  const languageAtLaunch = shallowRef<OverlayPrefs['languageAtLaunch'] | undefined>(undefined);
  const writes = useSettingWritesStore();
  // A read never overwrites a value set since it was asked for: the first read skips each key set before it answered,
  // and a change main pushes skips each key whose write main has not answered yet.
  const setBeforeLoad = new Set<string>();
  const writing = new Map<string, number>();
  let loaded = false;

  function merge(prefs: OverlayPrefs, skip: (key: string) => boolean): void {
    languageAtLaunch.value = prefs.languageAtLaunch;
    values.value = { ...values.value, ...Object.fromEntries(Object.entries(prefs.values).filter(([key]) => !skip(key))) };
  }

  function answered(key: string): void {
    const left = (writing.get(key) ?? 1) - 1;
    if (left === 0) writing.delete(key);
    else writing.set(key, left);
  }

  const prefs: DesktopPrefs = {
    values,
    languageAtLaunch,
    api,
    set(key, value) {
      if (!loaded) setBeforeLoad.add(key);
      writing.set(key, (writing.get(key) ?? 0) + 1);
      const before = values.value[key];
      writes.begin(key, () => (values.value = { ...values.value, [key]: before }));
      values.value = { ...values.value, [key]: value };
      void api.setPref(key, value).then(
        (result) => {
          answered(key);
          writes.settle(result.ok
            ? { type: 'settingWriteResult', key, ok: true, scope: 'user', file: result.file }
            : { type: 'settingWriteResult', key, ok: false, error: result.error });
        },
        (error: unknown) => {
          answered(key);
          writes.settle({ type: 'settingWriteResult', key, ok: false, error: error instanceof Error ? error.message : String(error) });
        },
      );
    },
  };
  void api.getPrefs().then((result) => {
    loaded = true;
    merge(result, (key) => setBeforeLoad.has(key));
  });
  onScopeDispose(api.onPrefsChanged((result) => merge(result, (key) => writing.has(key))));
  provide(PREFS, prefs);
  return prefs;
}

export function useDesktopPrefs(): DesktopPrefs {
  const prefs = inject(PREFS, null);
  if (!prefs) throw new Error('useDesktopPrefs called outside the overlay settings');
  return prefs;
}
