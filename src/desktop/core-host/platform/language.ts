import type { Disposable } from '../../../platform/disposable';
import type { LocalizationService } from '../../../platform/localization-service';
import type { CoreEndpoint, CoreInit } from '../../core-protocol';

/** The display language main's language mirror holds; core renders no text, so it reads no catalog. */
export function createLanguageMirror(endpoint: CoreEndpoint, init: CoreInit): LocalizationService & Disposable {
  let language: string = init.mirrors.language.language;
  const subscription = endpoint.onMirror('language', (patch) => {
    language = patch.language;
  });
  return {
    get language() {
      return language;
    },
    dispose: () => subscription.dispose(),
  };
}
