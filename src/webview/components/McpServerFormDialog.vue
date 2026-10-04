<script setup lang="ts">
/**
 * Add / edit form for a server in `~/.damocles/mcp.json`; rules live in `mcp-server-form-logic.ts`.
 *
 * There is no raw `bearerToken` field, but that is NOT "no credential can be stored here": `env` and
 * `headers` take arbitrary values and are the ordinary home for an MCP token, so they are masked by
 * default and the file is written 0600.
 *
 * The overlay stays open until the extension acknowledges the write — a rejection it cannot predict
 * would otherwise discard everything the user typed. The MCP servers overlay mounts it once per add
 * or edit, so its state starts from the props it mounts with.
 */
import type { McpServerConfig, McpWriteErrorInfo } from '@shared/types/mcp';
import { computed, nextTick, ref, shallowRef, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { Check, Eye, EyeOff, Globe, LoaderCircle, Pencil, Plus, SquareTerminal, Trash2 } from 'lucide-vue-next';
import OverlayShell from './OverlayShell.vue';
import SlidingIndicator from './SlidingIndicator.vue';
import { useSlidingIndicator } from '@/composables/useSlidingIndicator';
import {
  buildMcpServerConfig,
  createArgRow,
  createEmptyFormState,
  createKeyValueRow,
  formStateFromConfig,
  isMcpFormValid,
  mcpToolPrefixCollision,
  submittedServerName,
  validateMcpServerForm,
  type McpCollisionServer,
  type McpFormErrors,
  type McpFormField,
  type McpFormFieldError,
  type McpKeyValueRow,
  type McpServerFormState,
} from './mcp-server-form-logic';

const { t } = useI18n();

const props = defineProps<{
  /** The server being edited, or null when adding. Also the name excluded from collision checks. */
  editingName: string | null;
  /** The stored definition to pre-populate from (`editableConfig`), or null when adding. */
  editingConfig: McpServerConfig | null;
  /** The merged server list, used to mirror the extension's name-collision policy inline. */
  servers: McpCollisionServer[];
  /** True between emitting `save` and the extension's acknowledgement. Disables the form. */
  submitting: boolean;
  /** The extension's reason for refusing the last write, or null. */
  writeError: McpWriteErrorInfo | null;
}>();

const emit = defineEmits<{
  (e: 'save', serverName: string, config: McpServerConfig): void;
  (e: 'cancel'): void;
}>();

const state = ref<McpServerFormState>(createEmptyFormState());
const submitAttempted = ref(false);
const confirmingDiscard = ref(false);
/** Ids of `env`/`headers` rows whose value is currently shown in the clear. */
const revealed = ref<Set<string>>(new Set());
/** Snapshot taken when the form opens, so "has the user typed anything" is answerable on dismiss. */
const pristine = ref('');
const ids = useId();
const formEl = ref<HTMLFormElement | null>(null);

function snapshot(value: McpServerFormState): string {
  return JSON.stringify(value);
}

state.value =
  props.editingName !== null && props.editingConfig !== null
    ? formStateFromConfig(props.editingName, props.editingConfig)
    : createEmptyFormState();
pristine.value = snapshot(state.value);

const errors = computed<McpFormErrors>(() =>
  validateMcpServerForm(state.value, props.editingName, props.servers),
);

/**
 * Errors stay hidden until the first save attempt so a half-typed form is not shouting, then track
 * the fields live so a fix visibly clears the message.
 */
const shownErrors = computed<McpFormErrors>(() => (submitAttempted.value ? errors.value : {}));

/** Legal, but a lower-precedence server shares its namespace key and will not load: a note, not a blocker. */
const prefixCollision = computed(() =>
  mcpToolPrefixCollision(state.value.name, props.editingName, props.servers),
);

const isDirty = computed(() => snapshot(state.value) !== pristine.value);

function errorText(error: McpFormFieldError | undefined): string {
  if (!error) return '';
  return error.params ? t(error.key, error.params) : t(error.key);
}

/** The extension's refusal, translated. `invalidDefinition`/`writeFailed` carry English detail. */
const writeErrorText = computed(() => {
  const error = props.writeError;
  if (!error) return '';
  return t(`mcp.form.writeErrors.${error.code}`, error.params ?? {});
});

function addArg(): void {
  state.value.args.push(createArgRow());
}

function removeArg(index: number): void {
  state.value.args.splice(index, 1);
}

function addRow(rows: McpKeyValueRow[]): void {
  rows.push(createKeyValueRow());
}

function removeRow(rows: McpKeyValueRow[], index: number): void {
  const [removed] = rows.splice(index, 1);
  if (removed) revealed.value.delete(removed.id);
}

function toggleReveal(row: McpKeyValueRow): void {
  const next = new Set(revealed.value);
  if (next.has(row.id)) next.delete(row.id);
  else next.add(row.id);
  revealed.value = next;
}

/** The first field carrying an error, so an invalid submit moves focus rather than only colouring. */
const FOCUS_ORDER: McpFormField[] = [
  'name',
  'command',
  'env',
  'url',
  'headers',
  'bearerTokenEnv',
  'oauthAuthServerMetadataUrl',
  'oauthCallbackUrl',
  'oauthCallbackPort',
  'timeout',
];

async function focusFirstError(): Promise<void> {
  await nextTick();
  const field = FOCUS_ORDER.find((name) => errors.value[name]);
  if (!field) return;
  const target = formEl.value?.querySelector<HTMLElement>(`[data-field="${field}"]`);
  target?.focus();
}

/**
 * Nothing is emitted while the form is invalid, so an invalid definition never reaches the extension
 * and never reaches disk. The button stays enabled on purpose: a disabled Save with no explanation is
 * a dead end, whereas clicking it reveals exactly which fields are wrong.
 *
 * Re-entry is blocked while a write is in flight, so a second submit cannot send the definition twice and
 * be refused as "already exists" by the row the first one created.
 */
function handleSave(): void {
  if (props.submitting) return;
  submitAttempted.value = true;
  if (!isMcpFormValid(errors.value)) {
    void focusFirstError();
    return;
  }
  emit('save', submittedServerName(state.value), buildMcpServerConfig(state.value));
}

/** Escape, ✕ and Cancel land here, and a scrim click on a pristine form. A filled-in form asks before throwing the work away. */
function requestClose(): void {
  if (props.submitting) return;
  if (isDirty.value && !confirmingDiscard.value) {
    confirmingDiscard.value = true;
    return;
  }
  emit('cancel');
}

const MODES = [
  { value: 'stdio', labelKey: 'mcp.form.modeStdio', icon: SquareTerminal },
  { value: 'remote', labelKey: 'mcp.form.modeRemote', icon: Globe },
] as const;
const modeGroup = shallowRef<HTMLElement | null>(null);
const { box: modeBox, animate: modeAnimate } = useSlidingIndicator(modeGroup, 'label', () => (state.value.mode === 'stdio' ? 0 : 1));

const footerNote = computed(() => {
  if (confirmingDiscard.value) return { text: t('mcp.form.discardConfirm'), danger: true };
  if (submitAttempted.value && !isMcpFormValid(errors.value)) return { text: t('overlays.mcp.form.fixFields'), danger: true };
  return { text: t('overlays.mcp.form.writtenTo'), danger: false };
});

const FIELD = 'h-8 min-w-0 rounded-lg border bg-(--d-input) px-2.5 text-12.5 text-(--d-text) outline-none transition-colors placeholder:text-(--d-faint) focus:border-(--d-accent) disabled:opacity-60';
const fieldClass = (error: unknown, mono = true): string[] => [FIELD, mono ? 'font-mono' : '', error ? 'border-(--d-danger)' : 'border-(--d-border2)'];
const ICON_BUTTON = 'flex size-8 flex-none items-center justify-center rounded-lg text-(--d-faint) transition-colors hover:bg-(--d-hover)';
const ADD_BUTTON = '-ml-1 flex h-6.5 items-center gap-1.25 self-start rounded-7 px-2.25 text-xs text-(--d-accent) transition-colors hover:bg-(--d-hover) hover:text-(--d-accent-text)';
</script>

<template>
  <OverlayShell
    :title="editingName === null ? t('mcp.form.addTitle') : t('mcp.form.editTitle')"
    :subtitle="t('mcp.form.description')"
    :icon="editingName === null ? Plus : Pencil"
    max-width="38.75rem"
    :has-draft="isDirty || submitting"
    data-testid="mcp-server-form"
    @close="requestClose"
  >
    <form
      :id="`${ids}-form`"
      ref="formEl"
      novalidate
      @submit.prevent="handleSave"
    >
      <fieldset
        :disabled="submitting"
        class="m-0 flex flex-col gap-3.5 border-0 px-4.5 pt-3.5 pb-4.5"
      >
        <!-- The extension refused the last attempt; the form is still holding what was typed. -->
        <p
          v-if="writeError"
          :id="`${ids}-write-error`"
          role="alert"
          class="rounded-9 border border-[color-mix(in_srgb,var(--d-danger)_30%,transparent)] bg-[color-mix(in_srgb,var(--d-danger)_8%,transparent)] px-3 py-2 text-xs text-(--d-danger-text)"
        >
          {{ writeErrorText }}
        </p>

        <div class="flex flex-col gap-1.25">
          <label
            :for="`${ids}-name`"
            class="text-xs font-semibold"
          >{{ t('mcp.form.nameLabel') }}</label>
          <input
            :id="`${ids}-name`"
            v-model="state.name"
            data-field="name"
            data-overlay-initial-focus
            :placeholder="t('mcp.form.namePlaceholder')"
            :aria-invalid="shownErrors.name ? 'true' : undefined"
            :aria-describedby="shownErrors.name ? `${ids}-name-error` : undefined"
            :class="fieldClass(shownErrors.name)"
          >
          <p
            v-if="shownErrors.name"
            :id="`${ids}-name-error`"
            role="alert"
            class="text-11 text-(--d-danger)"
          >
            {{ errorText(shownErrors.name) }}
          </p>
          <p
            v-else-if="prefixCollision"
            class="text-11 text-(--d-warning)"
          >
            {{ t('mcp.form.prefixCollision', { other: prefixCollision.name }) }}
          </p>
        </div>

        <div class="flex flex-col gap-1.25">
          <label
            :for="`${ids}-description`"
            class="text-xs font-semibold"
          >{{ t('mcp.form.descriptionLabel') }}</label>
          <input
            :id="`${ids}-description`"
            v-model="state.description"
            data-field="description"
            :placeholder="t('mcp.form.descriptionPlaceholder')"
            :aria-describedby="`${ids}-description-help`"
            :class="fieldClass(null, false)"
          >
          <p
            :id="`${ids}-description-help`"
            class="text-11 text-(--d-faint)"
          >
            {{ t('mcp.form.descriptionHelp') }}
          </p>
        </div>

        <fieldset class="m-0 flex flex-col gap-1.25 border-0 p-0">
          <legend class="mb-1.25 text-xs font-semibold">
            {{ t('mcp.form.modeLabel') }}
          </legend>
          <div
            ref="modeGroup"
            class="relative isolate flex self-start rounded-lg bg-(--d-hover) p-0.5"
          >
            <SlidingIndicator
              :box="modeBox"
              :radius="6"
              :animate="modeAnimate"
              class="text-(--d-card)"
            />
            <label
              v-for="mode in MODES"
              :key="mode.value"
              class="relative z-1 flex h-6.5 cursor-pointer items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors has-focus-visible:outline-2 has-focus-visible:outline-(--d-accent) has-focus-visible:outline-solid"
              :class="state.mode === mode.value ? 'text-(--d-text)' : 'text-(--d-muted) hover:text-(--d-text)'"
            >
              <input
                v-model="state.mode"
                type="radio"
                :value="mode.value"
                :name="`${ids}-mode`"
                class="sr-only"
              >
              <component
                :is="mode.icon"
                class="size-3"
                aria-hidden="true"
              />
              {{ t(mode.labelKey) }}
            </label>
          </div>
          <p class="text-11 text-(--d-faint)">
            {{ t('mcp.form.modeSwitchHint') }}
          </p>
        </fieldset>

        <template v-if="state.mode === 'stdio'">
          <div class="flex flex-col gap-1.25">
            <label
              :for="`${ids}-command`"
              class="text-xs font-semibold"
            >{{ t('mcp.form.commandLabel') }}</label>
            <input
              :id="`${ids}-command`"
              v-model="state.command"
              data-field="command"
              :placeholder="t('mcp.form.commandPlaceholder')"
              :aria-invalid="shownErrors.command ? 'true' : undefined"
              :aria-describedby="shownErrors.command ? `${ids}-command-error` : undefined"
              :class="fieldClass(shownErrors.command)"
            >
            <p
              v-if="shownErrors.command"
              :id="`${ids}-command-error`"
              role="alert"
              class="text-11 text-(--d-danger)"
            >
              {{ errorText(shownErrors.command) }}
            </p>
          </div>

          <fieldset class="m-0 flex flex-col gap-1.5 border-0 p-0">
            <legend class="mb-1.25 text-xs font-semibold">
              {{ t('mcp.form.argsLabel') }}
            </legend>
            <div
              v-for="(arg, index) in state.args"
              :key="arg.id"
              class="flex items-center gap-1.5"
            >
              <input
                v-model="arg.value"
                :aria-label="t('mcp.form.argAriaLabel', { position: index + 1 })"
                :placeholder="t('mcp.form.argPlaceholder')"
                :class="[fieldClass(null), 'flex-1']"
              >
              <button
                type="button"
                :class="[ICON_BUTTON, 'hover:text-(--d-danger)']"
                :aria-label="t('mcp.form.removeArg')"
                :title="t('mcp.form.removeArg')"
                @click="removeArg(index)"
              >
                <Trash2
                  class="size-3.25"
                  aria-hidden="true"
                />
              </button>
            </div>
            <button
              type="button"
              :class="ADD_BUTTON"
              @click="addArg"
            >
              <Plus
                class="size-3"
                aria-hidden="true"
              />{{ t('mcp.form.addArg') }}
            </button>
          </fieldset>

          <fieldset class="m-0 flex flex-col gap-1.5 border-0 p-0">
            <legend class="mb-1.25 text-xs font-semibold">
              {{ t('mcp.form.envLabel') }}
            </legend>
            <div
              v-for="(row, index) in state.env"
              :key="row.id"
              class="flex items-center gap-1.5"
            >
              <input
                v-model="row.key"
                data-field="env"
                :aria-label="t('mcp.form.envKeyAriaLabel')"
                :placeholder="t('mcp.form.keyPlaceholder')"
                :aria-invalid="shownErrors.env ? 'true' : undefined"
                :aria-describedby="shownErrors.env ? `${ids}-env-error` : undefined"
                :class="[fieldClass(shownErrors.env), 'flex-1']"
              >
              <input
                v-model="row.value"
                :type="revealed.has(row.id) ? 'text' : 'password'"
                :aria-label="t('mcp.form.envValueAriaLabel')"
                :placeholder="t('mcp.form.valuePlaceholder')"
                :class="[fieldClass(null), 'flex-[1.3]']"
              >
              <button
                type="button"
                :class="[ICON_BUTTON, 'hover:text-(--d-text)']"
                :aria-label="revealed.has(row.id) ? t('mcp.form.hideValue') : t('mcp.form.revealValue')"
                :title="revealed.has(row.id) ? t('mcp.form.hideValue') : t('mcp.form.revealValue')"
                :aria-pressed="revealed.has(row.id)"
                @click="toggleReveal(row)"
              >
                <component
                  :is="revealed.has(row.id) ? EyeOff : Eye"
                  class="size-3.25"
                  aria-hidden="true"
                />
              </button>
              <button
                type="button"
                :class="[ICON_BUTTON, 'hover:text-(--d-danger)']"
                :aria-label="t('mcp.form.removeEnv')"
                :title="t('mcp.form.removeEnv')"
                @click="removeRow(state.env, index)"
              >
                <Trash2
                  class="size-3.25"
                  aria-hidden="true"
                />
              </button>
            </div>
            <button
              type="button"
              :class="ADD_BUTTON"
              @click="addRow(state.env)"
            >
              <Plus
                class="size-3"
                aria-hidden="true"
              />{{ t('mcp.form.addEnv') }}
            </button>
            <p class="text-11 text-(--d-faint)">
              {{ t('mcp.form.secretValueHint') }}
            </p>
            <p class="text-11 text-(--d-faint)">
              {{ t('mcp.form.valueSyntaxHint') }}
            </p>
            <p
              v-if="shownErrors.env"
              :id="`${ids}-env-error`"
              role="alert"
              class="text-11 text-(--d-danger)"
            >
              {{ errorText(shownErrors.env) }}
            </p>
          </fieldset>

          <div class="flex flex-col gap-1.25">
            <label
              :for="`${ids}-cwd`"
              class="text-xs font-semibold"
            >{{ t('mcp.form.cwdLabel') }}</label>
            <input
              :id="`${ids}-cwd`"
              v-model="state.cwd"
              :placeholder="t('mcp.form.cwdPlaceholder')"
              :class="fieldClass(null)"
            >
          </div>
        </template>

        <template v-else>
          <div class="flex flex-col gap-1.25">
            <label
              :for="`${ids}-url`"
              class="text-xs font-semibold"
            >{{ t('mcp.form.urlLabel') }}</label>
            <input
              :id="`${ids}-url`"
              v-model="state.url"
              data-field="url"
              :placeholder="t('mcp.form.urlPlaceholder')"
              :aria-invalid="shownErrors.url ? 'true' : undefined"
              :aria-describedby="shownErrors.url ? `${ids}-url-error` : undefined"
              :class="fieldClass(shownErrors.url)"
            >
            <p
              v-if="shownErrors.url"
              :id="`${ids}-url-error`"
              role="alert"
              class="text-11 text-(--d-danger)"
            >
              {{ errorText(shownErrors.url) }}
            </p>
          </div>

          <fieldset class="m-0 flex flex-col gap-1.5 border-0 p-0">
            <legend class="mb-1.25 text-xs font-semibold">
              {{ t('mcp.form.headersLabel') }}
            </legend>
            <div
              v-for="(row, index) in state.headers"
              :key="row.id"
              class="flex items-center gap-1.5"
            >
              <input
                v-model="row.key"
                data-field="headers"
                :aria-label="t('mcp.form.headerKeyAriaLabel')"
                :placeholder="t('mcp.form.headerKeyPlaceholder')"
                :aria-invalid="shownErrors.headers ? 'true' : undefined"
                :aria-describedby="shownErrors.headers ? `${ids}-headers-error` : undefined"
                :class="[fieldClass(shownErrors.headers), 'flex-1']"
              >
              <input
                v-model="row.value"
                :type="revealed.has(row.id) ? 'text' : 'password'"
                :aria-label="t('mcp.form.headerValueAriaLabel')"
                :placeholder="t('mcp.form.valuePlaceholder')"
                :class="[fieldClass(null), 'flex-[1.3]']"
              >
              <button
                type="button"
                :class="[ICON_BUTTON, 'hover:text-(--d-text)']"
                :aria-label="revealed.has(row.id) ? t('mcp.form.hideValue') : t('mcp.form.revealValue')"
                :title="revealed.has(row.id) ? t('mcp.form.hideValue') : t('mcp.form.revealValue')"
                :aria-pressed="revealed.has(row.id)"
                @click="toggleReveal(row)"
              >
                <component
                  :is="revealed.has(row.id) ? EyeOff : Eye"
                  class="size-3.25"
                  aria-hidden="true"
                />
              </button>
              <button
                type="button"
                :class="[ICON_BUTTON, 'hover:text-(--d-danger)']"
                :aria-label="t('mcp.form.removeHeader')"
                :title="t('mcp.form.removeHeader')"
                @click="removeRow(state.headers, index)"
              >
                <Trash2
                  class="size-3.25"
                  aria-hidden="true"
                />
              </button>
            </div>
            <button
              type="button"
              :class="ADD_BUTTON"
              @click="addRow(state.headers)"
            >
              <Plus
                class="size-3"
                aria-hidden="true"
              />{{ t('mcp.form.addHeader') }}
            </button>
            <p class="text-11 text-(--d-faint)">
              {{ t('mcp.form.secretValueHint') }}
            </p>
            <p class="text-11 text-(--d-faint)">
              {{ t('mcp.form.valueSyntaxHint') }}
            </p>
            <p
              v-if="shownErrors.headers"
              :id="`${ids}-headers-error`"
              role="alert"
              class="text-11 text-(--d-danger)"
            >
              {{ errorText(shownErrors.headers) }}
            </p>
          </fieldset>

          <div class="flex flex-col gap-1.25">
            <label
              :for="`${ids}-bearer-token-env`"
              class="text-xs font-semibold"
            >{{ t('mcp.form.bearerTokenEnvLabel') }}</label>
            <input
              :id="`${ids}-bearer-token-env`"
              v-model="state.bearerTokenEnv"
              data-field="bearerTokenEnv"
              :placeholder="t('mcp.form.bearerTokenEnvPlaceholder')"
              :aria-invalid="shownErrors.bearerTokenEnv ? 'true' : undefined"
              :aria-describedby="
                shownErrors.bearerTokenEnv
                  ? `${ids}-bearer-token-env-help ${ids}-bearer-token-env-error`
                  : `${ids}-bearer-token-env-help`
              "
              :class="fieldClass(shownErrors.bearerTokenEnv)"
            >
            <p
              :id="`${ids}-bearer-token-env-help`"
              class="text-11 text-(--d-faint)"
            >
              {{ t('mcp.form.bearerTokenEnvHelp') }}
            </p>
            <p
              v-if="shownErrors.bearerTokenEnv"
              :id="`${ids}-bearer-token-env-error`"
              role="alert"
              class="text-11 text-(--d-danger)"
            >
              {{ errorText(shownErrors.bearerTokenEnv) }}
            </p>
          </div>

          <fieldset
            class="m-0 flex flex-col gap-3 rounded-10 border border-(--d-border) bg-(--d-panel) p-3"
            :aria-describedby="`${ids}-oauth-help`"
          >
            <legend class="sr-only">
              {{ t('mcp.form.oauthLabel') }}
            </legend>
            <div>
              <p
                class="text-xs font-semibold"
                aria-hidden="true"
              >
                {{ t('mcp.form.oauthLabel') }}
              </p>
              <p
                :id="`${ids}-oauth-help`"
                class="text-11 text-(--d-faint)"
              >
                {{ t('mcp.form.oauthHelp') }}
              </p>
            </div>

            <div class="flex flex-col gap-1.25">
              <label
                :for="`${ids}-oauth-client-name`"
                class="text-xs font-semibold"
              >{{ t('mcp.form.oauthClientNameLabel') }}</label>
              <input
                :id="`${ids}-oauth-client-name`"
                v-model="state.oauthClientName"
                data-field="oauthClientName"
                :placeholder="t('mcp.form.oauthClientNamePlaceholder')"
                :class="fieldClass(null, false)"
              >
            </div>

            <div class="flex flex-col gap-1.25">
              <label
                :for="`${ids}-oauth-metadata-url`"
                class="text-xs font-semibold"
              >{{ t('mcp.form.oauthAuthServerMetadataUrlLabel') }}</label>
              <input
                :id="`${ids}-oauth-metadata-url`"
                v-model="state.oauthAuthServerMetadataUrl"
                data-field="oauthAuthServerMetadataUrl"
                :placeholder="t('mcp.form.oauthAuthServerMetadataUrlPlaceholder')"
                :aria-invalid="shownErrors.oauthAuthServerMetadataUrl ? 'true' : undefined"
                :aria-describedby="shownErrors.oauthAuthServerMetadataUrl ? `${ids}-oauth-metadata-url-error` : undefined"
                :class="fieldClass(shownErrors.oauthAuthServerMetadataUrl)"
              >
              <p
                v-if="shownErrors.oauthAuthServerMetadataUrl"
                :id="`${ids}-oauth-metadata-url-error`"
                role="alert"
                class="text-11 text-(--d-danger)"
              >
                {{ errorText(shownErrors.oauthAuthServerMetadataUrl) }}
              </p>
            </div>

            <div class="flex flex-col gap-1.25">
              <label
                :for="`${ids}-oauth-callback-url`"
                class="text-xs font-semibold"
              >{{ t('mcp.form.oauthCallbackUrlLabel') }}</label>
              <input
                :id="`${ids}-oauth-callback-url`"
                v-model="state.oauthCallbackUrl"
                data-field="oauthCallbackUrl"
                :placeholder="t('mcp.form.oauthCallbackUrlPlaceholder')"
                :aria-invalid="shownErrors.oauthCallbackUrl ? 'true' : undefined"
                :aria-describedby="shownErrors.oauthCallbackUrl ? `${ids}-oauth-callback-url-error` : undefined"
                :class="fieldClass(shownErrors.oauthCallbackUrl)"
              >
              <p
                v-if="shownErrors.oauthCallbackUrl"
                :id="`${ids}-oauth-callback-url-error`"
                role="alert"
                class="text-11 text-(--d-danger)"
              >
                {{ errorText(shownErrors.oauthCallbackUrl) }}
              </p>
            </div>

            <div class="flex flex-col gap-1.25">
              <label
                :for="`${ids}-oauth-callback-port`"
                class="text-xs font-semibold"
              >{{ t('mcp.form.oauthCallbackPortLabel') }}</label>
              <input
                :id="`${ids}-oauth-callback-port`"
                v-model="state.oauthCallbackPort"
                data-field="oauthCallbackPort"
                inputmode="numeric"
                :placeholder="t('mcp.form.oauthCallbackPortPlaceholder')"
                :aria-invalid="shownErrors.oauthCallbackPort ? 'true' : undefined"
                :aria-describedby="
                  shownErrors.oauthCallbackPort
                    ? `${ids}-oauth-callback-help ${ids}-oauth-callback-port-error`
                    : `${ids}-oauth-callback-help`
                "
                :class="[fieldClass(shownErrors.oauthCallbackPort), 'max-w-35']"
              >
              <p
                :id="`${ids}-oauth-callback-help`"
                class="text-11 text-(--d-faint)"
              >
                {{ t('mcp.form.oauthCallbackHelp') }}
              </p>
              <p
                v-if="shownErrors.oauthCallbackPort"
                :id="`${ids}-oauth-callback-port-error`"
                role="alert"
                class="text-11 text-(--d-danger)"
              >
                {{ errorText(shownErrors.oauthCallbackPort) }}
              </p>
            </div>
          </fieldset>
        </template>

        <div class="flex flex-col gap-1.25">
          <label
            :for="`${ids}-timeout`"
            class="text-xs font-semibold"
          >{{ t('mcp.form.timeoutLabel') }}</label>
          <input
            :id="`${ids}-timeout`"
            v-model="state.timeout"
            data-field="timeout"
            inputmode="decimal"
            :placeholder="t('mcp.form.timeoutPlaceholder')"
            :aria-invalid="shownErrors.timeout ? 'true' : undefined"
            :aria-describedby="shownErrors.timeout ? `${ids}-timeout-help ${ids}-timeout-error` : `${ids}-timeout-help`"
            :class="[fieldClass(shownErrors.timeout), 'max-w-35']"
          >
          <p
            :id="`${ids}-timeout-help`"
            class="text-11 text-(--d-faint)"
          >
            {{ t('mcp.form.timeoutHelp') }}
          </p>
          <p
            v-if="shownErrors.timeout"
            :id="`${ids}-timeout-error`"
            role="alert"
            class="text-11 text-(--d-danger)"
          >
            {{ errorText(shownErrors.timeout) }}
          </p>
        </div>
      </fieldset>
    </form>

    <template #footer>
      <div class="flex flex-none flex-wrap items-center gap-2 border-t border-(--d-border) bg-(--d-panel) px-3.5 py-2.5">
        <span
          class="min-w-0 flex-[1_1_12.5rem] text-11.5"
          :class="footerNote.danger ? 'text-(--d-danger)' : 'text-(--d-faint)'"
          :role="footerNote.danger ? 'alert' : undefined"
          data-testid="mcp-form-note"
        >{{ footerNote.text }}</span>
        <button
          type="button"
          class="d-press flex h-8 items-center rounded-9 px-3.5 text-12.5 font-medium transition-colors hover:bg-(--d-hover)"
          :class="confirmingDiscard ? 'text-(--d-danger) hover:text-(--d-danger-text)' : 'text-(--d-text)'"
          :disabled="submitting"
          @click="requestClose"
        >
          {{ confirmingDiscard ? t('mcp.form.discardConfirmAction') : t('common.cancel') }}
        </button>
        <button
          type="submit"
          :form="`${ids}-form`"
          class="d-press flex h-8 items-center gap-1.75 rounded-9 bg-(--d-accent) px-4 text-12.5 font-semibold text-(--d-on-accent) disabled:opacity-60"
          :disabled="submitting"
          :aria-busy="submitting || undefined"
        >
          <LoaderCircle
            v-if="submitting"
            class="size-3.25 d-spinning"
            aria-hidden="true"
          />
          <Check
            v-else
            class="size-3.25"
            aria-hidden="true"
          />
          {{ submitting ? t('mcp.form.saving') : t('common.save') }}
        </button>
      </div>
    </template>
  </OverlayShell>
</template>
