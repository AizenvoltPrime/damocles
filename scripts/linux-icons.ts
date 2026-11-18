// electron-builder.yml linux.icon. A deb or rpm installs each as hicolor/<size>x<size>/apps/damocles.png, and icon themes
// search only the size folders hicolor's index.theme lists, so a single icon.png of any other size shows nowhere. The deb
// and rpm install checks in release.yml list the same sizes.
export const LINUX_ICON_SIZES: readonly number[] = [16, 24, 32, 48, 64, 128, 256, 512];
export const LINUX_ICONS_FOLDER = 'build/icons';
