import type { Component } from 'vue';
import { BookOpen, Braces, File, FileCode, FileImage, FlaskConical, Folder, FolderOpen, KeyRound, Palette } from 'lucide-vue-next';

export interface FileIcon {
  readonly icon: Component;
  // a --d-* colour token
  readonly color: string;
}

const IMAGE = /\.(?:png|jpe?g|gif|webp|bmp|ico|svg)$/i;
const CODE = /\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|cs|cpp|c|h|hpp|rb|php|swift|scala|lua|sh|ps1)$/i;

/** The reference's file icons (Damocles Desktop.dc.html `fileIcon`), coloured from the design tokens. */
export function fileIcon(name: string, directory = false, open = false): FileIcon {
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
