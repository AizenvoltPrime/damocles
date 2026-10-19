<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ArrowLeft, Braces, FileText, Folder, FolderOpen } from 'lucide-vue-next';
import type { McpResourceRow, McpResourceTemplateRow } from '@shared/types/mcp';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '@shared/types/messages';
import { isBinaryMimeType } from '@shared/mcp-resource-mime';
import { parseUriTemplate, resolveUriTemplate, uriTemplateVariables, type UriTemplateValue, type UriTemplateVariable } from '@shared/uri-template';
import { visibleText } from '@shared/visible-text';
import { Button } from '@/components/ui/button';
import { Command, CommandGroup, CommandInput, CommandItem, CommandList, isListEdgeChord, isListPageKey } from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { formatBytes } from '@/utils/format-bytes';
import OverlayShell from './OverlayShell.vue';

// One MCP server's resources and templates, as VS Code's resource quick access lists them: a filter that keeps focus while
// the arrow keys move through the rows and Enter runs a row's one action (Open a directory in place, Attach a resource, Fill
// in a template), pages on demand, and a template form with the server's completions. A pick is attached to this chat's
// composer by reference; core reads it when the message is sent.
const props = defineProps<{ serverName: string }>();
const emit = defineEmits<{ close: []; attached: [] }>();

const { t, locale } = useI18n();
const { postMessage, onMessage } = usePlatformBridge();
const ids = useId();

// VS Code's completion debounce (mcpResourceQuickAccess.ts RunOnceScheduler).
const COMPLETION_DEBOUNCE_MS = 300;

type PickerRequest = Extract<WebviewToExtensionMessage, { type: 'requestMcpResources' | 'requestMcpResourceTemplates' | 'requestMcpResourceChildren' | 'requestMcpResourceCompletion' | 'attachMcpResource' }>;
type Reply = Extract<ExtensionToWebviewMessage, { requestId: string }>;

const isReply = (message: ExtensionToWebviewMessage): message is Reply => 'requestId' in message && typeof message.requestId === 'string';

const pending = new Map<string, (reply: Reply) => void>();
const unsubscribe = onMessage((message) => {
  if (!isReply(message)) return;
  const handle = pending.get(message.requestId);
  if (!handle) return;
  pending.delete(message.requestId);
  handle(message);
});

function request(build: (requestId: string) => PickerRequest, onReply: (reply: Reply) => void): string {
  const requestId = crypto.randomUUID();
  pending.set(requestId, onReply);
  postMessage(build(requestId));
  return requestId;
}

/** The items of a page no earlier page or earlier item listed, since a server may repeat one. */
function unseen<T>(listed: readonly T[], page: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set(listed.map(key));
  return page.filter((item) => {
    const id = key(item);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// Option values; a resource and a template never share one.
const BACK = 'back';
const MORE_RESOURCES = 'more:resources';
const MORE_TEMPLATES = 'more:templates';
const resourceValue = (row: McpResourceRow): string => `resource:${row.uri}`;
const templateValue = (template: McpResourceTemplateRow): string => `template:${template.uriTemplate}`;

const command = ref<InstanceType<typeof Command> | null>(null);
// The option to highlight once it renders: the row a Back or the form returns to, a directory's first child, a page's first new row.
let pendingHighlight: string | null = null;

interface Listing<T> {
  rows: T[];
  cursor: string | undefined;
  loading: boolean;
  error: string | null;
}

const resources = reactive<Listing<McpResourceRow>>({ rows: [], cursor: undefined, loading: true, error: null });
const templates = reactive<Listing<McpResourceTemplateRow>>({ rows: [], cursor: undefined, loading: true, error: null });

// A failed page keeps its cursor and error until the retry answers, so its Retry row stays where the highlight is.
function loadResources(cursor?: string): void {
  resources.loading = true;
  request((requestId) => ({ type: 'requestMcpResources', requestId, serverName: props.serverName, ...(cursor === undefined ? {} : { cursor }) }), (reply) => {
    if (reply.type !== 'mcpResources') return;
    const added = unseen(resources.rows, reply.resources, (row) => row.uri);
    resources.loading = false;
    resources.error = reply.error ?? null;
    resources.rows = [...resources.rows, ...added];
    resources.cursor = reply.error ? cursor : reply.nextCursor;
    if (cursor !== undefined && added[0]) pendingHighlight = resourceValue(added[0]);
  });
}

function loadTemplates(cursor?: string): void {
  templates.loading = true;
  request((requestId) => ({ type: 'requestMcpResourceTemplates', requestId, serverName: props.serverName, ...(cursor === undefined ? {} : { cursor }) }), (reply) => {
    if (reply.type !== 'mcpResourceTemplates') return;
    const added = unseen(templates.rows, reply.templates, (template) => template.uriTemplate);
    templates.loading = false;
    templates.error = reply.error ?? null;
    templates.rows = [...templates.rows, ...added];
    templates.cursor = reply.error ? cursor : reply.nextCursor;
    if (cursor !== undefined && added[0]) pendingHighlight = templateValue(added[0]);
  });
}

loadResources();
loadTemplates();

interface DirectoryLevel {
  row: McpResourceRow;
  children: McpResourceRow[];
  loading: boolean;
  error: string | null;
}

const directories = ref<DirectoryLevel[]>([]);
const directory = computed(() => directories.value.at(-1));
/** Rows shown as directories whose read returned their own content: files, offered for Attach. */
const openedAsFile = ref(new Set<string>());

function isDirectory(row: McpResourceRow): boolean {
  return row.directory === true && !openedAsFile.value.has(row.uri);
}

const filter = ref('');
const attaching = ref<string | null>(null);
const attachError = ref<string | null>(null);
const attachErrorElement = ref<HTMLElement | null>(null);

function openDirectory(row: McpResourceRow): void {
  const level = reactive<DirectoryLevel>({ row, children: [], loading: true, error: null });
  directories.value = [...directories.value, level];
  filter.value = '';
  attachError.value = null;
  request((requestId) => ({ type: 'requestMcpResourceChildren', requestId, serverName: props.serverName, uri: row.uri }), (reply) => {
    if (reply.type !== 'mcpResourceChildren') return;
    const shown = directory.value === level;
    if (reply.notDirectory) {
      openedAsFile.value = new Set([...openedAsFile.value, row.uri]);
      directories.value = directories.value.filter((open) => open !== level);
      if (shown) pendingHighlight = resourceValue(row);
      return;
    }
    level.loading = false;
    level.children = unseen([], reply.children, (child) => child.uri);
    level.error = reply.error ?? null;
    if (shown) pendingHighlight = level.children[0] ? resourceValue(level.children[0]) : BACK;
  });
}

function back(): void {
  const left = directories.value.at(-1);
  directories.value = directories.value.slice(0, -1);
  filter.value = '';
  attachError.value = null;
  if (left) pendingHighlight = resourceValue(left.row);
}

const backLabel = computed(() => {
  const parent = directories.value.at(-2);
  return parent ? t('mcp.resourcePicker.backToDirectory', { name: label(parent.row) }) : t('mcp.resourcePicker.backToResources');
});

function label(row: { title?: string; name: string }): string {
  return row.title || row.name;
}

function details(row: McpResourceRow): string {
  const size = row.size === undefined ? '' : formatBytes(row.size, locale.value);
  if (row.mimeType && size) return t('mcp.resourcePicker.details', { type: row.mimeType, size });
  return row.mimeType || size;
}

/** Why a row cannot be attached: a deny rule, or a type the model cannot take. */
function unavailableReason(row: { mimeType?: string; denied?: { rule: string } }): string | null {
  if (row.denied) return t('mcp.resourcePicker.denied', { rule: row.denied.rule });
  if (isBinaryMimeType(row.mimeType)) return t('mcp.resourcePicker.binary', { type: row.mimeType });
  return null;
}

const matches = (...fields: (string | undefined)[]): boolean => {
  const needle = filter.value.trim().toLocaleLowerCase(locale.value);
  return needle === '' || fields.some((field) => field?.toLocaleLowerCase(locale.value).includes(needle));
};

const resourceOptions = computed(() => (directory.value ? directory.value.children : resources.rows)
  .filter((row) => matches(row.title, row.name, row.uri))
  .map((row) => {
    const opens = isDirectory(row);
    return { row, value: resourceValue(row), opens, unavailable: opens ? null : unavailableReason(row) };
  }));
const templateOptions = computed(() => (directory.value ? [] : templates.rows)
  .filter((template) => matches(template.title, template.name, template.uriTemplate))
  .map((template) => ({ template, value: templateValue(template), unavailable: unavailableReason(template) })));

const moreResources = computed(() => !directory.value && (resources.cursor !== undefined || resources.error !== null));
const moreTemplates = computed(() => !directory.value && (templates.cursor !== undefined || templates.error !== null));

const listError = computed(() => (directory.value ? directory.value.error : resources.error));

// Live regions announce a change, not their first text, so they stay empty until the overlay has painted.
const live = ref(false);
onMounted(() => requestAnimationFrame(() => (live.value = true)));

const resourceStatus = computed(() => {
  if (!live.value) return '';
  const level = directory.value;
  if (level ? level.loading : resources.loading) return t('mcp.resourcePicker.loading');
  if (listError.value) return '';
  if (level && level.children.length === 0) return t('mcp.resourcePicker.emptyDirectory');
  if (!level && resources.rows.length === 0) return resources.cursor === undefined ? t('mcp.resourcePicker.noResources') : '';
  return resourceOptions.value.length === 0 ? t('mcp.resourcePicker.noMatches') : '';
});
const templateStatus = computed(() => {
  if (!live.value) return '';
  if (templates.loading) return t('mcp.resourcePicker.loading');
  return !templates.error && templates.rows.length === 0 && templates.cursor === undefined ? t('mcp.resourcePicker.noTemplates') : '';
});

watch(attachError, async (error) => {
  if (!error) return;
  await nextTick();
  attachErrorElement.value?.scrollIntoView({ block: 'nearest' });
});

function attach(uri: string, name: string, mimeType: string | undefined): void {
  if (attaching.value !== null) return;
  attaching.value = uri;
  attachError.value = null;
  request((requestId) => ({ type: 'attachMcpResource', requestId, serverName: props.serverName, uri, name, ...(mimeType ? { mimeType } : {}) }), (reply) => {
    if (reply.type !== 'mcpResourceAttached') return;
    attaching.value = null;
    if (reply.refused) attachError.value = reply.refused;
    else emit('attached');
  });
}

interface TemplateForm {
  template: McpResourceTemplateRow;
  variables: UriTemplateVariable[];
  values: Record<string, string>;
  completions: Record<string, string[]>;
}

const form = ref<TemplateForm | null>(null);
const parsedTemplate = computed(() => (form.value ? parseUriTemplate(form.value.template.uriTemplate) : null));
const completionTimers = new Map<string, ReturnType<typeof setTimeout>>();
const latestCompletion = new Map<string, string>();
// What each variable's completion was last asked for, so a focus asks only once per value.
const askedFor = new Map<string, string>();

function clearCompletion(name: string): void {
  clearTimeout(completionTimers.get(name));
  completionTimers.delete(name);
  latestCompletion.delete(name);
}

function openTemplate(template: McpResourceTemplateRow): void {
  const variables = uriTemplateVariables(parseUriTemplate(template.uriTemplate));
  form.value = reactive({
    template,
    variables,
    values: Object.fromEntries(variables.map((variable) => [variable.name, ''])),
    completions: {},
  });
  attachError.value = null;
  void nextTick(() => (document.getElementById(`${ids}-var-0`) ?? document.getElementById(`${ids}-template-attach`))?.focus());
}

function closeTemplate(): void {
  const left = form.value?.template;
  for (const name of [...completionTimers.keys(), ...latestCompletion.keys()]) clearCompletion(name);
  askedFor.clear();
  form.value = null;
  attachError.value = null;
  if (left) pendingHighlight = templateValue(left);
  void nextTick(() => document.getElementById(`${ids}-filter`)?.focus());
}

function complete(name: string): void {
  const current = form.value;
  if (!current) return;
  clearCompletion(name);
  const value = current.values[name] ?? '';
  askedFor.set(name, value);
  const context = Object.fromEntries(Object.entries(current.values).filter(([other, entry]) => other !== name && entry !== ''));
  const requestId = request((id) => ({
    type: 'requestMcpResourceCompletion',
    requestId: id,
    serverName: props.serverName,
    template: current.template.uriTemplate,
    argument: name,
    value,
    context,
  }), (reply) => {
    if (reply.type !== 'mcpResourceCompletion' || latestCompletion.get(name) !== requestId || form.value !== current) return;
    current.completions[name] = [...new Set(reply.values)].filter((entry) => entry !== current.values[name]);
  });
  latestCompletion.set(name, requestId);
}

function onFocusVariable(name: string): void {
  if (askedFor.get(name) !== (form.value?.values[name] ?? '')) complete(name);
}

function onInputVariable(name: string, value: string | number): void {
  if (!form.value) return;
  form.value.values[name] = String(value);
  // As VS Code's picker does, suggestions for the previous value go, and a reply still on its way for it is dropped.
  form.value.completions[name] = [];
  clearCompletion(name);
  completionTimers.set(name, setTimeout(() => complete(name), COMPLETION_DEBOUNCE_MS));
}

function pickCompletion(name: string, index: number, value: string): void {
  if (!form.value) return;
  form.value.values[name] = value;
  form.value.completions[name] = [];
  clearCompletion(name);
  askedFor.set(name, value);
  void nextTick(() => document.getElementById(`${ids}-var-${index}`)?.focus());
}

/** A list variable (`{/path*}`) takes a `/`-separated value, as VS Code splits it. */
const templateValues = computed<Record<string, UriTemplateValue | undefined>>(() => {
  const current = form.value;
  if (!current) return {};
  return Object.fromEntries(current.variables.map((variable) => {
    const value = current.values[variable.name] ?? '';
    if (value === '') return [variable.name, undefined];
    return [variable.name, variable.explode ? value.split('/') : value];
  }));
});
const resolvedUri = computed(() => (parsedTemplate.value ? resolveUriTemplate(parsedTemplate.value, templateValues.value) : ''));
// A named variable (`{?q}`) may stay empty; every other one needs a value.
const formComplete = computed(() => form.value?.variables.every((variable) => variable.named || (form.value?.values[variable.name] ?? '') !== '') ?? false);
const formHasInput = computed(() => Object.values(form.value?.values ?? {}).some((value) => value !== ''));

/** Two resources filled from one template read apart by their values. */
function filledName(current: TemplateForm): string {
  const values = current.variables.map((variable) => current.values[variable.name] ?? '').filter((value) => value !== '');
  if (values.length === 0) return label(current.template);
  const list = new Intl.ListFormat(locale.value, { style: 'short', type: 'unit' }).format(values);
  return t('mcp.resourcePicker.filledName', { name: label(current.template), values: list });
}

function attachTemplate(): void {
  const current = form.value;
  if (!current || !formComplete.value) return;
  attach(resolvedUri.value, filledName(current), current.template.mimeType);
}

/** Every option the list renders, in order; none while the form replaces the list. */
const optionValues = computed(() => (form.value ? [] : [
  ...(directory.value ? [BACK] : []),
  ...resourceOptions.value.map((option) => option.value),
  ...(moreResources.value ? [MORE_RESOURCES] : []),
  ...templateOptions.value.map((option) => option.value),
  ...(moreTemplates.value ? [MORE_TEMPLATES] : []),
]));

let highlightedValue: string | undefined;
// Set once the highlight is one the user moved to or a navigation returned to; until then arriving rows keep the first one highlighted.
let highlightPlaced = false;

function onHighlight(item: { value: unknown } | undefined): void {
  highlightedValue = typeof item?.value === 'string' ? item.value : undefined;
}

watch(filter, () => (highlightPlaced = false));

// As VS Code's quick pick does: the first option until the user moves, the one a navigation asked for once it renders.
// reka registers a new option one flush after it mounts, so the highlight waits for that flush.
watch([optionValues, command], async () => {
  await nextTick();
  const list = command.value;
  if (!list || optionValues.value.length === 0) return;
  if (pendingHighlight !== null && optionValues.value.includes(pendingHighlight)) {
    list.highlightItem(pendingHighlight);
    pendingHighlight = null;
    highlightPlaced = true;
  } else if (!highlightPlaced || !list.hasHighlight()) {
    list.highlightFirstItem();
  }
}, { flush: 'post' });

// Runs before reka's own keys on the filter. VS Code's quick pick loops at either end of the list, where reka stops.
function onListKeydown(event: KeyboardEvent): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && !isListEdgeChord(event) && !isListPageKey(event)) return;
  highlightPlaced = true;
  const values = optionValues.value;
  const list = command.value;
  const edge = event.key === 'ArrowDown' ? values.at(-1) : event.key === 'ArrowUp' ? values[0] : undefined;
  if (!list || edge === undefined || values.length < 2 || highlightedValue !== edge || !list.hasHighlight()) return;
  event.preventDefault();
  event.stopPropagation();
  list.highlightItem((event.key === 'ArrowDown' ? values[0] : values.at(-1))!);
}

// Each row runs its action, as VS Code's accept does, instead of reka selecting it (and toggling it off on a second pick).
function selectResource(event: Event, row: McpResourceRow): void {
  event.preventDefault();
  if (isDirectory(row)) openDirectory(row);
  else if (!unavailableReason(row)) attach(row.uri, label(row), row.mimeType);
}

function selectTemplate(event: Event, template: McpResourceTemplateRow): void {
  event.preventDefault();
  if (!unavailableReason(template)) openTemplate(template);
}

function selectMore(event: Event, listing: Listing<unknown>, load: (cursor?: string) => void): void {
  event.preventDefault();
  if (!listing.loading) load(listing.cursor);
}

function selectBack(event: Event): void {
  event.preventDefault();
  back();
}

onUnmounted(() => {
  unsubscribe();
  pending.clear();
  for (const timer of completionTimers.values()) clearTimeout(timer);
});

// reka re-renders an option's attributes only when its highlight changes, so a state that changes under it goes in its content.
// The highlighted row is the selected one (accent-soft), apart from a merely hovered one, as VS Code's focused and hovered list rows differ.
const ITEM = 'group scroll-mt-14 items-start gap-3 rounded-lg px-3 py-2 text-13 text-(--d-text) not-data-highlighted:hover:bg-(--d-hover) data-highlighted:bg-(--d-accent-soft) data-highlighted:text-(--d-text) aria-disabled:cursor-default';
const FAINT = 'text-(--d-faint) group-hover:text-(--d-faint-text) group-data-highlighted:text-(--d-faint-text)';
const HINT = 'ms-auto flex-none self-center rounded-7 border border-(--d-border2) px-2 py-0.5 text-11 text-(--d-muted) group-aria-disabled:opacity-50';
const HEADING = 'px-3 pt-0 pb-1 text-11 font-semibold tracking-wide text-(--d-faint) uppercase';
const ROW_BUTTON = 'h-7 rounded-lg px-3 text-xs';
const FIELD = 'h-8 rounded-9 border-(--d-border2) bg-(--d-input) px-2.75 text-13 text-(--d-text) placeholder:text-(--d-faint) focus-visible:border-(--d-accent) focus-visible:ring-0 focus-visible:ring-offset-0';
const STATUS = 'px-3 py-2 text-xs text-(--d-muted) empty:py-0';
const ERROR = 'rounded-9 border border-[color-mix(in_srgb,var(--d-danger)_30%,transparent)] bg-[color-mix(in_srgb,var(--d-danger)_8%,transparent)] px-3 py-2 text-xs text-(--d-danger-text)';
</script>

<template>
  <OverlayShell
    :title="t('mcp.resourcePicker.title', { serverName })"
    :subtitle="t('mcp.resourcePicker.subtitle')"
    :icon="FolderOpen"
    max-width="45rem"
    :has-draft="formHasInput"
    data-testid="mcp-resource-picker"
    @close="emit('close')"
  >
    <!-- One listbox root for the list and the form, so leaving the form restores its row rather than reka's mount-time pick. -->
    <Command
      ref="command"
      keep-highlight
      class="block size-auto overflow-visible rounded-none bg-transparent text-13 text-(--d-text)"
      @highlight="onHighlight"
    >
      <form
        v-if="form"
        class="flex flex-col gap-3 px-4 pt-3 pb-4.5"
        data-testid="mcp-template-form"
        :aria-labelledby="`${ids}-form-title`"
        novalidate
        @submit.prevent="attachTemplate"
      >
        <Button
          type="button"
          variant="ghost"
          :class="[ROW_BUTTON, 'self-start ps-1.5 text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text)']"
          data-testid="mcp-template-back"
          @click="closeTemplate"
        >
          <ArrowLeft
            class="size-3.5"
            aria-hidden="true"
          />{{ t('mcp.resourcePicker.backToTemplates') }}
        </Button>
        <div>
          <h3
            :id="`${ids}-form-title`"
            class="font-semibold"
          >
            {{ label(form.template) }}
          </h3>
          <p
            v-if="form.template.description"
            class="text-xs text-(--d-muted)"
          >
            {{ form.template.description }}
          </p>
          <p class="font-mono text-11.5 break-all text-(--d-muted)">
            {{ visibleText(form.template.uriTemplate) }}
          </p>
          <p class="mt-1 text-xs text-(--d-faint)">
            {{ t('mcp.resourcePicker.templateHint') }}
          </p>
        </div>
        <div
          v-for="(variable, index) in form.variables"
          :key="variable.name"
          class="flex flex-col gap-1.25"
        >
          <label
            :for="`${ids}-var-${index}`"
            class="text-xs font-semibold"
          >{{ variable.name }}<span
            v-if="variable.named"
            class="ms-1.5 font-normal text-(--d-faint)"
          >{{ t('mcp.resourcePicker.optional') }}</span></label>
          <Input
            :id="`${ids}-var-${index}`"
            :model-value="form.values[variable.name] ?? ''"
            :class="FIELD"
            autocomplete="off"
            spellcheck="false"
            :data-template-variable="variable.name"
            @update:model-value="onInputVariable(variable.name, $event)"
            @focus="onFocusVariable(variable.name)"
          />
          <ul
            v-if="(form.completions[variable.name] ?? []).length > 0"
            :aria-label="t('mcp.resourcePicker.suggestions', { name: variable.name })"
            class="flex flex-wrap gap-1.5"
            :data-completions-for="variable.name"
          >
            <li
              v-for="value in form.completions[variable.name]"
              :key="value"
            >
              <Button
                type="button"
                variant="ghost"
                class="h-6.5 rounded-7 border border-(--d-border2) px-2.25 font-mono text-11.5 hover:bg-(--d-hover)"
                data-testid="mcp-template-completion"
                @click="pickCompletion(variable.name, index, value)"
              >
                {{ value }}
              </Button>
            </li>
          </ul>
        </div>
        <div class="flex flex-col gap-1">
          <span class="text-xs font-semibold">{{ t('mcp.resourcePicker.resolved') }}</span>
          <code
            class="font-mono text-11.5 break-all text-(--d-text)"
            data-testid="mcp-template-uri"
          >{{ visibleText(resolvedUri) }}</code>
        </div>
        <p
          v-if="attachError"
          ref="attachErrorElement"
          role="alert"
          :class="ERROR"
          data-testid="mcp-resource-attach-error"
        >
          {{ attachError }}
        </p>
        <!-- Not disabled while attaching: a disabled button loses focus, which would drop to the page. -->
        <Button
          :id="`${ids}-template-attach`"
          type="submit"
          :class="[ROW_BUTTON, 'self-end bg-(--d-accent) text-(--d-on-accent) hover:bg-(--d-accent) aria-disabled:opacity-50']"
          :disabled="!formComplete"
          :aria-disabled="attaching !== null || undefined"
          data-testid="mcp-template-attach"
        >
          {{ attaching !== null ? t('mcp.resourcePicker.attaching') : t('mcp.resourcePicker.attach') }}
        </Button>
      </form>

      <template v-else>
        <div
          class="sticky top-0 z-10 flex flex-col gap-2 bg-(--d-bg) px-4 pt-3 pb-2"
          @keydown.capture="onListKeydown"
        >
          <CommandInput
            :id="`${ids}-filter`"
            v-model="filter"
            wrapper-class="h-8.5 rounded-10 border border-(--d-border2) bg-(--d-input) px-2.75 text-(--d-faint) transition-colors focus-within:border-(--d-accent)"
            class="h-full min-w-0 flex-1 py-0 text-13 text-(--d-text) placeholder:text-(--d-faint)"
            :placeholder="t('mcp.resourcePicker.filter')"
            :aria-label="t('mcp.resourcePicker.filter')"
            :aria-controls="`${ids}-list`"
            aria-autocomplete="list"
            data-overlay-initial-focus
            data-testid="mcp-resource-filter"
          />
          <p
            v-if="attachError"
            ref="attachErrorElement"
            role="alert"
            :class="ERROR"
            data-testid="mcp-resource-attach-error"
          >
            {{ attachError }}
          </p>
        </div>

        <CommandList
          :id="`${ids}-list`"
          :aria-label="t('mcp.resourcePicker.list', { serverName })"
          class="flex max-h-none flex-col gap-3 overflow-visible px-4 pb-4.5"
        >
          <CommandGroup
            :heading="directory ? label(directory.row) : t('mcp.resourcePicker.resources')"
            :heading-class="HEADING"
            class="p-0"
            data-testid="mcp-resource-section"
          >
            <p
              v-if="listError"
              role="alert"
              :class="[ERROR, 'mb-1']"
            >
              {{ listError }}
            </p>
            <CommandItem
              v-if="directory"
              :value="BACK"
              :class="[ITEM, 'items-center text-(--d-muted)']"
              data-testid="mcp-resource-back"
              @mousedown.prevent
              @select="selectBack"
            >
              <ArrowLeft aria-hidden="true" />{{ backLabel }}
            </CommandItem>
            <CommandItem
              v-for="option in resourceOptions"
              :key="option.value"
              :value="option.value"
              :class="ITEM"
              :aria-disabled="option.unavailable ? 'true' : undefined"
              data-testid="mcp-resource-row"
              :data-uri="option.row.uri"
              @mousedown.prevent
              @select="selectResource($event, option.row)"
            >
              <component
                :is="option.opens ? Folder : FileText"
                class="mt-0.5 text-(--d-muted)"
                aria-hidden="true"
              />
              <div class="min-w-0 flex-1">
                <p class="truncate font-medium">
                  {{ label(option.row) }}
                </p>
                <p
                  v-if="option.row.description"
                  class="line-clamp-2 text-xs text-(--d-muted)"
                >
                  {{ option.row.description }}
                </p>
                <p class="truncate font-mono text-11 text-(--d-muted)">
                  {{ visibleText(option.row.uri) }}
                </p>
                <p
                  v-if="details(option.row)"
                  :class="['text-11', FAINT]"
                  data-testid="mcp-resource-details"
                >
                  {{ details(option.row) }}
                </p>
                <p
                  v-if="option.unavailable"
                  class="text-11 text-(--d-muted)"
                  data-testid="mcp-resource-unavailable"
                >
                  {{ option.unavailable }}
                </p>
              </div>
              <span
                :class="HINT"
                data-testid="mcp-row-action"
              >{{ option.opens ? t('mcp.resourcePicker.open') : attaching === option.row.uri ? t('mcp.resourcePicker.attaching') : t('mcp.resourcePicker.attach') }}</span>
            </CommandItem>
            <CommandItem
              v-if="moreResources"
              :value="MORE_RESOURCES"
              :class="[ITEM, 'items-center text-(--d-accent-text) data-highlighted:text-(--d-accent-text)']"
              data-testid="mcp-resource-load-more"
              @mousedown.prevent
              @select="selectMore($event, resources, loadResources)"
            >
              {{ resources.error ? t('mcp.resourcePicker.retry') : t('mcp.resourcePicker.loadMore') }}
            </CommandItem>
            <p
              role="status"
              :class="STATUS"
              data-testid="mcp-resource-status"
            >
              {{ resourceStatus }}
            </p>
          </CommandGroup>

          <CommandGroup
            v-if="!directory"
            :heading="t('mcp.resourcePicker.templates')"
            :heading-class="HEADING"
            class="p-0"
            data-testid="mcp-template-section"
          >
            <p
              v-if="templates.error"
              role="alert"
              :class="[ERROR, 'mb-1']"
            >
              {{ templates.error }}
            </p>
            <CommandItem
              v-for="option in templateOptions"
              :key="option.value"
              :value="option.value"
              :class="ITEM"
              :aria-disabled="option.unavailable ? 'true' : undefined"
              data-testid="mcp-template-row"
              :data-uri-template="option.template.uriTemplate"
              @mousedown.prevent
              @select="selectTemplate($event, option.template)"
            >
              <Braces
                class="mt-0.5 text-(--d-muted)"
                aria-hidden="true"
              />
              <div class="min-w-0 flex-1">
                <p class="truncate font-medium">
                  {{ label(option.template) }}
                </p>
                <p
                  v-if="option.template.description"
                  class="line-clamp-2 text-xs text-(--d-muted)"
                >
                  {{ option.template.description }}
                </p>
                <p class="truncate font-mono text-11 text-(--d-muted)">
                  {{ visibleText(option.template.uriTemplate) }}
                </p>
                <p
                  v-if="option.unavailable"
                  class="text-11 text-(--d-muted)"
                  data-testid="mcp-resource-unavailable"
                >
                  {{ option.unavailable }}
                </p>
              </div>
              <span
                :class="HINT"
                data-testid="mcp-row-action"
              >{{ t('mcp.resourcePicker.fill') }}</span>
            </CommandItem>
            <CommandItem
              v-if="moreTemplates"
              :value="MORE_TEMPLATES"
              :class="[ITEM, 'items-center text-(--d-accent-text) data-highlighted:text-(--d-accent-text)']"
              data-testid="mcp-template-load-more"
              @mousedown.prevent
              @select="selectMore($event, templates, loadTemplates)"
            >
              {{ templates.error ? t('mcp.resourcePicker.retry') : t('mcp.resourcePicker.loadMore') }}
            </CommandItem>
            <p
              role="status"
              :class="STATUS"
              data-testid="mcp-template-status"
            >
              {{ templateStatus }}
            </p>
          </CommandGroup>
        </CommandList>
      </template>
    </Command>
  </OverlayShell>
</template>
