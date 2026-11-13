// Paged list reads of GitHub and GitLab: the next page is asked by number only, never by a URL a server returned.

/** The most pages one list read follows; a longer list is cut and says so. */
export const MAX_LIST_PAGES = 10;

/** Whether a list answer names a next page: GitLab's non-empty x-next-page, else GitHub's Link entry with rel="next". */
export function hasNextPage(headers: Headers): boolean {
  const gitlab = headers.get('x-next-page');
  if (gitlab !== null) return gitlab.trim() !== '';
  return (headers.get('link') ?? '').split(',').some((entry) => entry.split(';').slice(1).some((param) => /^\s*rel\s*=\s*"?next"?\s*$/i.test(param)));
}

export interface ListPage {
  readonly items: readonly unknown[];
  readonly next: boolean;
}

/** Pages 1 to MAX_LIST_PAGES of a list, in order, until one names no next page; truncated when the last read still did. */
export async function readPages(read: (page: number) => Promise<ListPage>): Promise<{ readonly items: unknown[]; readonly truncated: boolean }> {
  const items: unknown[] = [];
  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    const answer = await read(page);
    items.push(...answer.items);
    if (!answer.next) return { items, truncated: false };
  }
  return { items, truncated: true };
}
