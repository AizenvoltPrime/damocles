import { defineComponent, h, type PropType } from 'vue';
import { highlightParts } from './settings-view';
import { isolatedParts } from '@shared/bidi-isolate';

/** `text` with every match of `query` in an accent-soft <mark> (M6); a run marked with isolated() is a bdi element. */
export default defineComponent({
  name: 'SettingsHighlight',
  props: {
    text: { type: String as PropType<string>, required: true },
    query: { type: String as PropType<string>, required: true },
  },
  setup(props) {
    const marked = (text: string) => highlightParts(text, props.query).map((part) => (part.match ? h('mark', { class: 'sm-mark' }, part.text) : part.text));
    return () => isolatedParts(props.text).flatMap((run) => (run.isolated ? [h('bdi', marked(run.text))] : marked(run.text)));
  },
});
