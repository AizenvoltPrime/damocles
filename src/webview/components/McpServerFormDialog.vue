<script setup lang="ts">
/**
 * Add / edit form for a server in `~/.damocles/mcp.json`; rules live in `mcp-server-form-logic.ts`.
 *
 * There is no raw `bearerToken` field, but that is NOT "no credential can be stored here": `env` and
 * `headers` take arbitrary values and are the ordinary home for an MCP token, so they are masked by
 * default and the file is written 0600.
 *
 * The dialog stays open until the extension acknowledges the write — a rejection it cannot predict
 * would otherwise discard everything the user typed.
 */
import type { McpServerConfig, McpWriteErrorInfo } from '@shared/types/mcp';
import { computed, nextTick, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { IconTrash, IconEye } from '@/components/icons';
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
  visible: boolean;
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

watch(
  () => props.visible,
  (visible) => {
    if (!visible) return;
    state.value =
      props.editingName !== null && props.editingConfig !== null
        ? formStateFromConfig(props.editingName, props.editingConfig)
        : createEmptyFormState();
    submitAttempted.value = false;
    confirmingDiscard.value = false;
    // Existing secrets start masked; a value the user types this session is theirs to see.
    revealed.value = new Set();
    pristine.value = snapshot(state.value);
  },
  { immediate: true },
);

const errors = computed<McpFormErrors>(() =>
  validateMcpServerForm(state.value, props.editingName, props.servers),
);

/**
 * Errors stay hidden until the first save attempt so a half-typed form is not shouting, then track
 * the fields live so a fix visibly clears the message.
 */
const shownErrors = computed<McpFormErrors>(() => (submitAttempted.value ? errors.value : {}));

/** Legal, but its tool prefix collides with another server's — a note, not a blocker. */
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
const FOCUS_ORDER: McpFormField[] = ['name', 'command', 'url', 'env', 'headers', 'bearerTokenEnv'];

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
 * Re-entry is blocked while a write is in flight. Reka keeps `DialogContent` mounted through its exit
 * animation, so without this a double-click sends twice and the second attempt is rejected as "already
 * exists" — by the row the first one just created.
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

/** Escape, the overlay and ✕ all land here. A filled-in form asks before throwing the work away. */
function requestClose(): void {
  if (props.submitting) return;
  if (isDirty.value && !confirmingDiscard.value) {
    confirmingDiscard.value = true;
    return;
  }
  emit('cancel');
}

function handleOpenChange(open: boolean): void {
  if (!open) requestClose();
}
</script>

<template>
  <Dialog :open="visible" @update:open="handleOpenChange">
    <DialogContent class="bg-card border-border max-w-md max-h-[85vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>
          {{ editingName === null ? t('mcp.form.addTitle') : t('mcp.form.editTitle') }}
        </DialogTitle>
        <DialogDescription>{{ t('mcp.form.description') }}</DialogDescription>
      </DialogHeader>

      <form ref="formEl" class="space-y-4" novalidate @submit.prevent="handleSave">
        <fieldset :disabled="submitting" class="space-y-4 border-0 p-0 m-0">
          <!-- The extension refused the last attempt; the form is still holding what was typed. -->
          <p
            v-if="writeError"
            :id="`${ids}-write-error`"
            role="alert"
            class="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error"
          >
            {{ writeErrorText }}
          </p>

          <!-- Name -->
          <div class="space-y-1.5">
            <Label :for="`${ids}-name`">{{ t('mcp.form.nameLabel') }}</Label>
            <Input
              :id="`${ids}-name`"
              v-model="state.name"
              data-field="name"
              :placeholder="t('mcp.form.namePlaceholder')"
              :aria-invalid="shownErrors.name ? 'true' : undefined"
              :aria-describedby="shownErrors.name ? `${ids}-name-error` : undefined"
              class="h-8 text-sm"
            />
            <p v-if="shownErrors.name" :id="`${ids}-name-error`" role="alert" class="text-xs text-error">
              {{ errorText(shownErrors.name) }}
            </p>
            <p v-else-if="prefixCollision" class="text-xs text-muted-foreground">
              {{ t('mcp.form.prefixCollision', { other: prefixCollision }) }}
            </p>
          </div>

          <!-- Transport -->
          <fieldset class="space-y-1.5">
            <legend class="text-sm font-medium leading-none">{{ t('mcp.form.modeLabel') }}</legend>
            <div class="flex items-center gap-4 pt-1">
              <label class="flex items-center gap-1.5 text-sm cursor-pointer">
                <input v-model="state.mode" type="radio" value="stdio" :name="`${ids}-mode`" class="accent-primary" />
                {{ t('mcp.form.modeStdio') }}
              </label>
              <label class="flex items-center gap-1.5 text-sm cursor-pointer">
                <input v-model="state.mode" type="radio" value="remote" :name="`${ids}-mode`" class="accent-primary" />
                {{ t('mcp.form.modeRemote') }}
              </label>
            </div>
            <p class="text-xs text-muted-foreground">{{ t('mcp.form.modeSwitchHint') }}</p>
          </fieldset>

          <!-- stdio -->
          <template v-if="state.mode === 'stdio'">
            <div class="space-y-1.5">
              <Label :for="`${ids}-command`">{{ t('mcp.form.commandLabel') }}</Label>
              <Input
                :id="`${ids}-command`"
                v-model="state.command"
                data-field="command"
                :placeholder="t('mcp.form.commandPlaceholder')"
                :aria-invalid="shownErrors.command ? 'true' : undefined"
                :aria-describedby="shownErrors.command ? `${ids}-command-error` : undefined"
                class="h-8 text-sm font-mono"
              />
              <p v-if="shownErrors.command" :id="`${ids}-command-error`" role="alert" class="text-xs text-error">
                {{ errorText(shownErrors.command) }}
              </p>
            </div>

            <fieldset class="space-y-1.5">
              <legend class="text-sm font-medium leading-none">{{ t('mcp.form.argsLabel') }}</legend>
              <div v-for="(arg, index) in state.args" :key="arg.id" class="flex items-center gap-1.5">
                <Input
                  v-model="arg.value"
                  :aria-label="t('mcp.form.argAriaLabel', { position: index + 1 })"
                  :placeholder="t('mcp.form.argPlaceholder')"
                  class="h-8 text-sm font-mono"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  class="h-8 w-8 p-0 shrink-0 text-muted-foreground hover:text-error"
                  :aria-label="t('mcp.form.removeArg')"
                  @click="removeArg(index)"
                >
                  <IconTrash :size="14" />
                </Button>
              </div>
              <Button type="button" size="sm" variant="ghost" class="h-7 px-2 text-xs" @click="addArg">
                {{ t('mcp.form.addArg') }}
              </Button>
            </fieldset>

            <fieldset class="space-y-1.5">
              <legend class="text-sm font-medium leading-none">{{ t('mcp.form.envLabel') }}</legend>
              <div v-for="(row, index) in state.env" :key="row.id" class="flex items-center gap-1.5">
                <Input
                  v-model="row.key"
                  data-field="env"
                  :aria-label="t('mcp.form.envKeyAriaLabel')"
                  :placeholder="t('mcp.form.keyPlaceholder')"
                  :aria-invalid="shownErrors.env ? 'true' : undefined"
                  :aria-describedby="shownErrors.env ? `${ids}-env-error` : undefined"
                  class="h-8 text-sm font-mono"
                />
                <Input
                  v-model="row.value"
                  :type="revealed.has(row.id) ? 'text' : 'password'"
                  :aria-label="t('mcp.form.envValueAriaLabel')"
                  :placeholder="t('mcp.form.valuePlaceholder')"
                  class="h-8 text-sm font-mono"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  class="h-8 w-8 p-0 shrink-0 text-muted-foreground"
                  :aria-label="revealed.has(row.id) ? t('mcp.form.hideValue') : t('mcp.form.revealValue')"
                  :aria-pressed="revealed.has(row.id)"
                  @click="toggleReveal(row)"
                >
                  <IconEye :size="14" />
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  class="h-8 w-8 p-0 shrink-0 text-muted-foreground hover:text-error"
                  :aria-label="t('mcp.form.removeEnv')"
                  @click="removeRow(state.env, index)"
                >
                  <IconTrash :size="14" />
                </Button>
              </div>
              <Button type="button" size="sm" variant="ghost" class="h-7 px-2 text-xs" @click="addRow(state.env)">
                {{ t('mcp.form.addEnv') }}
              </Button>
              <p class="text-xs text-muted-foreground">{{ t('mcp.form.secretValueHint') }}</p>
              <p v-if="shownErrors.env" :id="`${ids}-env-error`" role="alert" class="text-xs text-error">
                {{ errorText(shownErrors.env) }}
              </p>
            </fieldset>

            <div class="space-y-1.5">
              <Label :for="`${ids}-cwd`">{{ t('mcp.form.cwdLabel') }}</Label>
              <Input :id="`${ids}-cwd`" v-model="state.cwd" :placeholder="t('mcp.form.cwdPlaceholder')" class="h-8 text-sm font-mono" />
            </div>
          </template>

          <!-- remote -->
          <template v-else>
            <div class="space-y-1.5">
              <Label :for="`${ids}-url`">{{ t('mcp.form.urlLabel') }}</Label>
              <Input
                :id="`${ids}-url`"
                v-model="state.url"
                data-field="url"
                :placeholder="t('mcp.form.urlPlaceholder')"
                :aria-invalid="shownErrors.url ? 'true' : undefined"
                :aria-describedby="shownErrors.url ? `${ids}-url-error` : undefined"
                class="h-8 text-sm font-mono"
              />
              <p v-if="shownErrors.url" :id="`${ids}-url-error`" role="alert" class="text-xs text-error">
                {{ errorText(shownErrors.url) }}
              </p>
            </div>

            <fieldset class="space-y-1.5">
              <legend class="text-sm font-medium leading-none">{{ t('mcp.form.remoteTypeLabel') }}</legend>
              <div class="flex items-center gap-4 pt-1">
                <label class="flex items-center gap-1.5 text-sm cursor-pointer">
                  <input v-model="state.remoteType" type="radio" value="http" :name="`${ids}-remote-type`" class="accent-primary" />
                  {{ t('mcp.form.remoteTypeHttp') }}
                </label>
                <label class="flex items-center gap-1.5 text-sm cursor-pointer">
                  <input v-model="state.remoteType" type="radio" value="sse" :name="`${ids}-remote-type`" class="accent-primary" />
                  {{ t('mcp.form.remoteTypeSse') }}
                </label>
              </div>
            </fieldset>

            <fieldset class="space-y-1.5">
              <legend class="text-sm font-medium leading-none">{{ t('mcp.form.headersLabel') }}</legend>
              <div v-for="(row, index) in state.headers" :key="row.id" class="flex items-center gap-1.5">
                <Input
                  v-model="row.key"
                  data-field="headers"
                  :aria-label="t('mcp.form.headerKeyAriaLabel')"
                  :placeholder="t('mcp.form.headerKeyPlaceholder')"
                  :aria-invalid="shownErrors.headers ? 'true' : undefined"
                  :aria-describedby="shownErrors.headers ? `${ids}-headers-error` : undefined"
                  class="h-8 text-sm font-mono"
                />
                <Input
                  v-model="row.value"
                  :type="revealed.has(row.id) ? 'text' : 'password'"
                  :aria-label="t('mcp.form.headerValueAriaLabel')"
                  :placeholder="t('mcp.form.valuePlaceholder')"
                  class="h-8 text-sm font-mono"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  class="h-8 w-8 p-0 shrink-0 text-muted-foreground"
                  :aria-label="revealed.has(row.id) ? t('mcp.form.hideValue') : t('mcp.form.revealValue')"
                  :aria-pressed="revealed.has(row.id)"
                  @click="toggleReveal(row)"
                >
                  <IconEye :size="14" />
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  class="h-8 w-8 p-0 shrink-0 text-muted-foreground hover:text-error"
                  :aria-label="t('mcp.form.removeHeader')"
                  @click="removeRow(state.headers, index)"
                >
                  <IconTrash :size="14" />
                </Button>
              </div>
              <Button type="button" size="sm" variant="ghost" class="h-7 px-2 text-xs" @click="addRow(state.headers)">
                {{ t('mcp.form.addHeader') }}
              </Button>
              <p class="text-xs text-muted-foreground">{{ t('mcp.form.secretValueHint') }}</p>
              <p v-if="shownErrors.headers" :id="`${ids}-headers-error`" role="alert" class="text-xs text-error">
                {{ errorText(shownErrors.headers) }}
              </p>
            </fieldset>

            <div class="space-y-1.5">
              <Label :for="`${ids}-bearer-token-env`">{{ t('mcp.form.bearerTokenEnvLabel') }}</Label>
              <Input
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
                class="h-8 text-sm font-mono"
              />
              <p :id="`${ids}-bearer-token-env-help`" class="text-xs text-muted-foreground">
                {{ t('mcp.form.bearerTokenEnvHelp') }}
              </p>
              <p
                v-if="shownErrors.bearerTokenEnv"
                :id="`${ids}-bearer-token-env-error`"
                role="alert"
                class="text-xs text-error"
              >
                {{ errorText(shownErrors.bearerTokenEnv) }}
              </p>
            </div>
          </template>
        </fieldset>

        <p v-if="confirmingDiscard" role="alert" class="text-xs text-error">
          {{ t('mcp.form.discardConfirm') }}
        </p>

        <div class="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" :disabled="submitting" @click="requestClose">
            {{ confirmingDiscard ? t('mcp.form.discardConfirmAction') : t('common.cancel') }}
          </Button>
          <Button type="submit" :disabled="submitting">
            {{ submitting ? t('mcp.form.saving') : t('common.save') }}
          </Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
</template>
