import type { ElectronApplication } from '@playwright/test';

/** Labels of every application menu item, depth first, with the item's id where it has one. */
export async function menuLabels(app: ElectronApplication): Promise<{ id: string; label: string }[]> {
  return app.evaluate(({ Menu }) => {
    const out: { id: string; label: string }[] = [];
    const walk = (items: Electron.MenuItem[]): void => {
      for (const item of items) {
        out.push({ id: item.id ?? '', label: item.label });
        if (item.submenu) walk(item.submenu.items);
      }
    };
    walk(Menu.getApplicationMenu()?.items ?? []);
    return out;
  });
}
