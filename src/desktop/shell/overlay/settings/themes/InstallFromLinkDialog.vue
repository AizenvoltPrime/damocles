<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Link } from 'lucide-vue-next';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import SettingButton from '@/components/settings/controls/SettingButton.vue';
import { parsePastedInstallUrl } from '@shared/themes/theme-links';

// Install from link: the user pastes an https link to a theme file; nothing installs until the install card's Install.
const props = defineProps<{
  // the download or check main is running for the sent link
  busy: boolean;
  // why main refused the sent link, in the UI's language
  failure: string | undefined;
}>();
const open = defineModel<boolean>('open', { required: true });
// edited: the text changed, so a refusal of the text that was sent no longer describes it
const emit = defineEmits<{ (e: 'submit', url: string): void; (e: 'edited'): void }>();

const { t } = useI18n();
const value = ref('');
const invalid = ref(false);
const inputRef = ref<InstanceType<typeof Input> | null>(null);

watch(open, (now) => {
  if (!now) return;
  value.value = '';
  invalid.value = false;
});
watch(value, () => {
  invalid.value = false;
  if (props.failure !== undefined) emit('edited');
});

function focusInput(): void {
  void nextTick(() => (inputRef.value?.$el as HTMLInputElement | undefined)?.focus());
}

// The text goes to main as typed, trimmed: main judges it again by the same rules as a link from the OS.
function submit(): void {
  if (props.busy) return;
  const text = value.value.trim();
  if (!parsePastedInstallUrl(text).ok) {
    invalid.value = true;
    focusInput();
    return;
  }
  emit('submit', text);
}

const errorText = computed(() => (invalid.value ? t('settingsHost.themes.link.invalid') : props.failure));
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent
      class="max-w-120 gap-3"
      data-testid="theme-link-dialog"
    >
      <DialogTitle class="flex items-center gap-2 text-13">
        <Link
          class="size-3.5 text-(--d-muted)"
          aria-hidden="true"
        />{{ t('settingsHost.themes.link.title') }}
      </DialogTitle>
      <DialogDescription class="text-12 text-pretty text-(--d-muted)">
        {{ t('settingsHost.themes.link.body') }}
      </DialogDescription>
      <form
        class="flex flex-col gap-1.5"
        novalidate
        @submit.prevent="submit"
      >
        <Label
          for="theme-link-url"
          class="text-12"
        >{{ t('settingsHost.themes.link.label') }}</Label>
        <Input
          id="theme-link-url"
          ref="inputRef"
          v-model="value"
          type="url"
          inputmode="url"
          placeholder="https://"
          autocomplete="off"
          spellcheck="false"
          class="h-8 text-12.5"
          :aria-invalid="errorText !== undefined ? 'true' : undefined"
          :aria-describedby="errorText !== undefined ? 'theme-link-error' : undefined"
          data-testid="theme-link-url"
        />
        <p
          v-if="errorText !== undefined"
          id="theme-link-error"
          class="text-11 text-pretty text-(--d-danger-text)"
          role="alert"
          data-testid="theme-link-error"
        >
          {{ errorText }}
        </p>
        <p
          v-else-if="busy"
          class="text-11 text-(--d-muted)"
          role="status"
          data-testid="theme-link-busy"
        >
          {{ t('settingsHost.themes.link.downloading') }}
        </p>
        <div class="mt-1 flex justify-end gap-2">
          <SettingButton
            data-testid="theme-link-cancel"
            @click="open = false"
          >
            {{ t('settingsHost.themes.cancel') }}
          </SettingButton>
          <SettingButton
            type="submit"
            variant="primary"
            :disabled="busy"
            data-testid="theme-link-continue"
          >
            {{ t('settingsHost.themes.link.continue') }}
          </SettingButton>
        </div>
      </form>
    </DialogContent>
  </Dialog>
</template>
