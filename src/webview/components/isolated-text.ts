import { h, type FunctionalComponent } from 'vue';
import { isolatedParts } from '@shared/bidi-isolate';

/**
 * A sentence whose user text was marked with isolated(): each marked run is a bdi element, so a name written right to left
 * keeps the numbers and punctuation beside it in place, and the element's text holds no mark. A render function, since a
 * template would put its own white space between the runs.
 */
export const IsolatedText: FunctionalComponent<{ readonly text: string }> = (props) =>
  isolatedParts(props.text).map((part) => (part.isolated ? h('bdi', part.text) : part.text));
IsolatedText.props = { text: { type: String, required: true } };
