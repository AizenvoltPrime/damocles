import { defineComponent, h, type PropType } from 'vue';
import { highlightParts } from './settings-view';

/** `text` with every match of `query` in an accent-soft <mark> (M6). */
export default defineComponent({
  name: 'SettingsHighlight',
  props: {
    text: { type: String as PropType<string>, required: true },
    query: { type: String as PropType<string>, required: true },
  },
  setup(props) {
    return () => highlightParts(props.text, props.query).map((part) => (part.match ? h('mark', { class: 'sm-mark' }, part.text) : part.text));
  },
});
