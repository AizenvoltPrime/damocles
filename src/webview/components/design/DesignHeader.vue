<script setup lang="ts">
import { computed, nextTick, ref, useId, watch, type ComponentPublicInstance } from 'vue';
import { useI18n } from 'vue-i18n';
import { FileText, Folder, Globe, Link, Monitor, Palette, PowerOff } from 'lucide-vue-next';
import type { DesignChatStateView } from '@shared/types/design';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useOpenDesignInBrowser } from '@/composables/useOpenDesignInBrowser';
import { useOpenDesignPreview } from '@/composables/useOpenDesignPreview';
import { useDesignStore } from '@/stores/useDesignStore';
import { formatBytes } from '@/utils/format-bytes';
import { prefersReducedMotion } from '@/utils/reducedMotion';
import { useOverflowStrip } from '@/composables/useOverflowStrip';
import OverflowSlider from '@/components/OverflowSlider.vue';
import DesignScreensMenu from './DesignScreensMenu.vue';
import DesignDecisionChip from './DesignDecisionChip.vue';
import { DESIGN_STRIP } from './design-strip';
import { DESIGN_MENU_CONTENT, DESIGN_MENU_ITEM, DESIGN_MENU_LABEL, DESIGN_MENU_STATUS } from './design-menu';

// The design chat's header: the way back to the main chat, the design folder's files, its screens in a preview tab (desktop)
// or the browser (VS Code), and the decisions so far. Its two rows never wrap, so it keeps DESIGN_STRIP's fixed height, which
// the shell's gutter edge continues.
const props = defineProps<{ design: DesignChatStateView }>();
const { t, locale } = useI18n();
const { postMessage } = usePlatformBridge();
const designStore = useDesignStore();
const { available: canOpenInBrowser } = useOpenDesignInBrowser();
const { available: canOpenPreview } = useOpenDesignPreview();

const CHIP = 'd-press h-6 min-w-0 gap-1.5 rounded-full border border-(--d-border2) bg-(--d-card) px-2 text-11.5 font-normal text-(--d-muted) hover:border-[color-mix(in_srgb,var(--d-design)_45%,var(--d-border2))] hover:bg-(--d-card) hover:text-(--d-text) focus-visible:ring-1 focus-visible:ring-(--d-design) focus-visible:ring-offset-0 disabled:opacity-(--d-opacity-disabled) [&_svg]:size-3';

const parentTitle = computed(() => props.design.parentTitle ?? t('design.header.parentChat'));
const fileList = computed(() => designStore.fileLists[props.design.designId]);
// A finished design the designer edited since keeps its version, now edited (D70).
const versionLabel = computed(() => {
  const { status, version } = props.design;
  if (version === null) return t('design.header.draft');
  return status === 'draft' ? t('design.header.edited', { version }) : t('design.header.version', { version });
});

function openParent(): void {
  postMessage({ type: 'openParentChat' });
}

function onFilesOpen(open: boolean): void {
  if (!open) return;
  designStore.filesRequested(props.design.designId);
  postMessage({ type: 'requestDesignFiles', designId: props.design.designId });
}

function openFile(file: string): void {
  postMessage({ type: 'openDesignFile', designId: props.design.designId, file });
}

// A new decision pops into the strip; scroll it into view so the user sees it land.
const strip = ref<HTMLElement | null>(null);
const stripRow = ref<ComponentPublicInstance | null>(null);
const overflow = useOverflowStrip(strip, stripRow);
const { fadeClass, onScroll, onWheel, onPointerEnter, onPointerLeave } = overflow;
const decisionsLabelId = useId();
watch(() => props.design.decisions.length, async (count, previous) => {
  if (previous === undefined || count <= previous) return;
  await nextTick();
  strip.value?.querySelector('li:last-child')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
});
</script>

<template>
  <section
    class="@container/design"
    :class="DESIGN_STRIP"
    :aria-label="t('design.header.label')"
    data-testid="design-header"
    :data-design-id="design.designId"
  >
    <div class="chat-column flex h-full flex-col justify-center gap-1.5">
      <div class="flex h-6 min-w-0 items-center gap-1.5">
        <span
          class="d-tone-design inline-flex h-6 flex-none items-center gap-1.5 rounded-full bg-(--tone)/14 px-2 text-11.5 font-semibold"
          data-testid="design-header-badge"
        >
          <Palette
            class="size-3"
            aria-hidden="true"
          />{{ t('design.mode.label') }}
          <span
            class="font-mono text-10.5 font-medium"
            data-testid="design-header-version"
          >{{ versionLabel }}</span>
        </span>

        <Button
          type="button"
          variant="ghost"
          :class="CHIP"
          :disabled="design.parentSessionId === null"
          :aria-label="design.parentSessionId === null ? t('design.header.noParent') : t('design.header.openParent', { title: parentTitle })"
          :title="design.parentSessionId === null ? t('design.header.noParent') : parentTitle"
          data-testid="design-header-parent"
          @click="openParent"
        >
          <Link
            class="size-3 flex-none text-(--d-design)"
            aria-hidden="true"
          />
          <span class="max-w-48 truncate">{{ design.parentSessionId === null ? t('design.header.noParent') : parentTitle }}</span>
        </Button>

        <DropdownMenu @update:open="onFilesOpen">
          <DropdownMenuTrigger as-child>
            <Button
              type="button"
              variant="ghost"
              :class="CHIP"
              :aria-label="t('design.header.folderFiles', { folder: design.folder })"
              :title="design.folder"
              data-testid="design-header-folder"
            >
              <Folder
                class="size-3 flex-none text-(--d-design)"
                aria-hidden="true"
              />
              <span
                class="max-w-56 truncate font-mono text-11"
                dir="ltr"
              >{{ design.folder }}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            :class="['w-80 max-w-[calc(100vw-2rem)]', DESIGN_MENU_CONTENT]"
            data-testid="design-files"
          >
            <DropdownMenuLabel
              :class="[DESIGN_MENU_LABEL, 'truncate font-mono']"
              dir="ltr"
              :title="design.folder"
            >
              {{ design.folder }}
            </DropdownMenuLabel>
            <DropdownMenuItem
              v-if="!fileList?.loaded"
              disabled
              :class="DESIGN_MENU_STATUS"
            >
              {{ t('design.header.filesLoading') }}
            </DropdownMenuItem>
            <DropdownMenuItem
              v-else-if="fileList.failed"
              disabled
              :class="[DESIGN_MENU_STATUS, 'text-(--d-danger-text)']"
              data-testid="design-files-failed"
            >
              {{ t('design.header.filesFailed') }}
            </DropdownMenuItem>
            <DropdownMenuItem
              v-else-if="fileList.files.length === 0"
              disabled
              :class="DESIGN_MENU_STATUS"
            >
              {{ t('design.header.filesEmpty') }}
            </DropdownMenuItem>
            <div
              v-else
              class="max-h-64 overflow-y-auto"
            >
              <DropdownMenuItem
                v-for="file in fileList.files"
                :key="file.path"
                :class="DESIGN_MENU_ITEM"
                :text-value="file.path"
                :aria-label="t('design.header.openFile', { file: file.path })"
                data-testid="design-file"
                @select="openFile(file.path)"
              >
                <FileText
                  class="text-(--d-faint-text)"
                  aria-hidden="true"
                />
                <span
                  class="min-w-0 flex-1 truncate font-mono text-11.5"
                  dir="ltr"
                >{{ file.path }}</span>
                <span class="flex-none text-10.5 text-(--d-faint-text)">{{ formatBytes(file.bytes, locale) }}</span>
              </DropdownMenuItem>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>

        <DesignScreensMenu
          v-if="canOpenPreview"
          :design-id="design.designId"
          target="preview"
        >
          <Button
            type="button"
            variant="ghost"
            :class="[CHIP, 'flex-none']"
            :title="t('design.preview.open')"
            data-testid="design-header-open-preview"
          >
            <Monitor
              class="size-3 flex-none text-(--d-design)"
              aria-hidden="true"
            />
            <span class="@max-[32rem]/design:sr-only">{{ t('design.preview.open') }}</span>
          </Button>
        </DesignScreensMenu>

        <DesignScreensMenu
          v-if="canOpenInBrowser"
          :design-id="design.designId"
          target="browser"
        >
          <Button
            type="button"
            variant="ghost"
            :class="[CHIP, 'flex-none']"
            :title="t('design.browser.open')"
            data-testid="design-header-open-browser"
          >
            <Globe
              class="size-3 flex-none text-(--d-design)"
              aria-hidden="true"
            />
            <span class="@max-[32rem]/design:sr-only">{{ t('design.browser.open') }}</span>
          </Button>
        </DesignScreensMenu>

        <span
          v-if="!design.enabled"
          class="d-tone-warning inline-flex h-6 flex-none items-center gap-1.25 rounded-full bg-(--tone)/14 px-2 text-11"
          :title="t('design.header.off')"
          data-testid="design-header-off"
        >
          <PowerOff
            class="size-3"
            aria-hidden="true"
          />
          <span class="@max-[32rem]/design:sr-only">{{ t('design.header.off') }}</span>
        </span>
      </div>

      <div class="flex h-6 min-w-0 items-center gap-2">
        <span
          :id="decisionsLabelId"
          class="flex-none text-10 font-semibold tracking-[.08em] text-(--d-faint-text) uppercase"
        >{{ t('design.header.decisions') }}</span>
        <span
          v-if="design.decisions.length === 0"
          class="min-w-0 truncate text-11 text-(--d-faint-text)"
        >{{ t('design.header.noDecisions') }}</span>
        <!-- The edge fade masks the strip's own outline, so its focus ring is drawn on this wrapper. -->
        <div
          v-else
          class="relative h-full min-w-0 flex-1 rounded-full has-focus-visible:outline-2 has-focus-visible:outline-(--d-design)"
          @pointerenter="onPointerEnter"
          @pointerleave="onPointerLeave"
        >
          <!-- Scrolls sideways; focusable so a keyboard user can scroll it too. -->
          <div
            ref="strip"
            role="region"
            :aria-labelledby="decisionsLabelId"
            tabindex="0"
            class="d-overflow-strip flex h-full items-center overflow-x-auto overflow-y-hidden overscroll-x-contain focus-visible:outline-none"
            :class="fadeClass"
            data-testid="design-decisions"
            @wheel="onWheel"
            @scroll="onScroll"
          >
            <TransitionGroup
              ref="stripRow"
              tag="ul"
              enter-active-class="animate-[d-pop_.26s_var(--ease-spring)]"
              class="flex w-max flex-none items-center gap-1"
            >
              <li
                v-for="decision in design.decisions"
                :key="decision.id"
                class="flex flex-none"
              >
                <DesignDecisionChip :decision="decision" />
              </li>
            </TransitionGroup>
          </div>
          <OverflowSlider :strip="overflow" />
        </div>
      </div>
    </div>
  </section>
</template>
