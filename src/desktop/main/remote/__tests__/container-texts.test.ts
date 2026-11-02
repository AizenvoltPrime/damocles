// A refused container action fills a toast the user reads in the app's language, never with main's English or a raw code.
import { describe, expect, it } from 'vitest';
import { createDesktopLocalizationService } from '../../../local-services/localization-service';
import { containerNameRefusedText, notContainerProjectText } from '../container-texts';

const quiet = (): void => undefined;
const greek = createDesktopLocalizationService(process.cwd(), 'el', quiet);
const english = createDesktopLocalizationService(process.cwd(), 'en', quiet);

describe('container refusal texts', () => {
  it('say a project left its container in the app\'s language', () => {
    expect(notContainerProjectText(english.t)).toBe('The project is not in a container any more.');
    expect(notContainerProjectText(greek.t)).toBe('Το έργο δεν βρίσκεται πλέον σε κοντέινερ.');
  });

  it('name the host holding the name, and never put a refusal code in the sentence', () => {
    expect(containerNameRefusedText({ ok: false, reason: 'taken', clashWith: 'app' }, english.t)).toBe('Another host is already named app.');
    expect(containerNameRefusedText({ ok: false, reason: 'taken', clashWith: 'app' }, greek.t)).toBe('Ένας άλλος κεντρικός υπολογιστής ονομάζεται ήδη app.');
    for (const reason of ['empty', 'controlChars', 'bidiChars', 'tooLong'] as const) {
      const text = containerNameRefusedText({ ok: false, reason }, greek.t);
      expect(text).toBe('Το όνομα του φακέλου δεν μπορεί να γίνει όνομα κεντρικού υπολογιστή.');
      expect(text).not.toContain(reason);
    }
  });
});
