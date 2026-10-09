import { describe, expect, it } from 'vitest';
import { tidyMenu, type OverlayMenuItem } from '../overlay-channels';

const item = (id: string): OverlayMenuItem => ({ kind: 'item', id, label: id });
const separator: OverlayMenuItem = { kind: 'separator' };

describe('tidyMenu', () => {
  it('drops the separators conditional sections leave at either end or doubled, and keeps the items in order', () => {
    expect(tidyMenu([separator, item('a'), separator, separator, item('b'), separator])).toEqual([item('a'), separator, item('b')]);
    expect(tidyMenu([separator, separator])).toEqual([]);
    expect(tidyMenu([])).toEqual([]);
    const plain = [item('a'), separator, item('b')];
    expect(tidyMenu(plain)).toEqual(plain);
  });
});
