import type { Component } from 'vue';
import { BookOpen, Braces, File, FileCode, FileImage, FlaskConical, Folder, FolderOpen, KeyRound, Palette } from 'lucide-vue-next';
import { hostAppearance } from './host-appearance';
import { materialIconName, materialIconUrl } from './material-icons';

// Material: an image that carries its own colours. Minimal: a lucide icon in a --d-* colour token.
export type FileIconLook = { readonly src: string } | { readonly icon: Component; readonly color: string };

const IMAGE = /\.(?:png|jpe?g|gif|webp|bmp|ico|svg)$/i;
const CODE = /\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|cs|cpp|c|h|hpp|rb|php|swift|scala|lua|sh|ps1)$/i;

/** The Minimal file icon theme: the reference's icons (Damocles Desktop.dc.html `fileIcon`), coloured from the design tokens. */
function minimalIcon(name: string, directory: boolean, open: boolean): FileIconLook {
  if (directory) return { icon: open ? FolderOpen : Folder, color: 'var(--d-muted)' };
  const lower = name.toLowerCase();
  if (/\.(?:spec|test)\.[cm]?[jt]sx?$/.test(lower)) return { icon: FlaskConical, color: 'var(--d-success)' };
  if (lower.endsWith('.vue')) return { icon: FileCode, color: 'var(--d-success)' };
  if (CODE.test(lower)) return { icon: FileCode, color: 'var(--d-accent)' };
  if (lower.endsWith('.json') || lower.endsWith('.jsonc')) return { icon: Braces, color: 'var(--d-warning)' };
  if (lower.endsWith('.md')) return { icon: BookOpen, color: 'var(--d-info)' };
  if (/\.(?:css|scss|less)$/.test(lower)) return { icon: Palette, color: 'var(--d-info)' };
  if (lower.startsWith('.env')) return { icon: KeyRound, color: 'var(--d-warning)' };
  if (IMAGE.test(lower)) return { icon: FileImage, color: 'var(--d-info)' };
  return { icon: File, color: 'var(--d-faint)' };
}

/**
 * The icon of a file or folder in the file icon theme the user picked, reactive to that theme and the theme kind. `path` is
 * the name or a `/` separated path; a path lets a theme match by parent folder, as Material does for `.github/workflows`.
 */
export function fileIconLook(path: string, directory: boolean, open: boolean): FileIconLook {
  const { kind, fileIconTheme } = hostAppearance();
  if (fileIconTheme === 'minimal') return minimalIcon(path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1), directory, open);
  return { src: materialIconUrl(materialIconName(path, directory, open, kind)) };
}
