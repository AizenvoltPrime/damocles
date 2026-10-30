import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, folderEntry, makeFakeHost, type Harness } from './panel-manager-harness';

let harness: Harness | undefined;

afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

describe('the error page of a panel whose restore failed', () => {
  it('carries the words of the host core builds it for, in that host\'s language', async () => {
    harness = createHarness([folderEntry('/ws')]);
    harness.failCreation.errors.push(new Error('no session'));
    const pages: string[] = [];
    const host = Object.assign(makeFakeHost(), {
      setHtml: (html: string) => { pages.push(html); },
      errorPageStrings: () => ({ title: 'Η επαναφορά της συνεδρίας απέτυχε', detail: 'Κλείστε αυτή την καρτέλα.' }),
    });

    await harness.manager.restorePanel(host, undefined);

    expect(pages.at(-1)).toContain('<h2>Η επαναφορά της συνεδρίας απέτυχε</h2>');
    expect(pages.at(-1)).toContain('<p>Κλείστε αυτή την καρτέλα.</p>');
  });
});
