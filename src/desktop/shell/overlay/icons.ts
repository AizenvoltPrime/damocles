import type { Component } from 'vue';
import { Check, Copy, FolderMinus, FolderOpen, MessageSquare, Pencil, PencilLine, Plus, ShieldCheck, Tag, Tags, Trash2, X } from 'lucide-vue-next';
import type { OverlayIcon } from '../../preload/overlay-channels';

export const OVERLAY_ICON_COMPONENTS: Readonly<Record<OverlayIcon, Component>> = {
  check: Check,
  copy: Copy,
  'folder-minus': FolderMinus,
  'folder-open': FolderOpen,
  'message-square': MessageSquare,
  pencil: Pencil,
  'pencil-line': PencilLine,
  plus: Plus,
  'shield-check': ShieldCheck,
  tag: Tag,
  tags: Tags,
  'trash-2': Trash2,
  x: X,
};
