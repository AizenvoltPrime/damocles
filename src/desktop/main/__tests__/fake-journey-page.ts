import type { JourneyCdp, JourneyCdpMethod } from '../design/design-journey';

/** An element of a fake page, as its accessibility tree, its DOM and its input handling show it. */
export interface FakeElement {
  readonly id: number;
  readonly tag: 'input' | 'textarea' | 'select' | 'button' | 'div' | 'ul' | 'span';
  readonly role?: string;
  readonly name?: string;
  // where the accessible name came from: a <label>, aria-label, or its own text
  readonly nameFrom?: 'label' | 'aria-label' | 'contents';
  readonly placeholder?: string;
  readonly text?: string;
  value?: string;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly shown?: (page: FakeJourneyPage) => boolean;
  readonly covered?: boolean;
  readonly click?: (page: FakeJourneyPage) => void;
  readonly key?: (key: string, page: FakeJourneyPage) => void;
  // a scrolling box: its top, scrollable height and visible height, which a wheel over it moves
  scroll?: { top: number; height: number; visible: number };
  // the id of the element it sits in; absent, the body
  readonly parent?: number;
}

const FOCUSABLE: ReadonlySet<FakeElement['tag']> = new Set(['input', 'textarea', 'select', 'button']);
const loose = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

const WANTED = /const wanted = ("(?:[^"\\]|\\.)*")/;
const quadOf = (id: number): number[] => [id * 20, 0, id * 20 + 10, 0, id * 20 + 10, 10, id * 20, 10];

/** A page the journey drives through CDP; it answers only the commands the journey sends and records each. */
export class FakeJourneyPage implements JourneyCdp {
  readonly sent: [JourneyCdpMethod, Record<string, unknown>][] = [];
  readonly state: Record<string, unknown> = {};
  readonly highlighted: number[] = [];
  readonly events: string[] = [];
  focused: number | undefined;
  // the page's own scrolling box, and what the page does when its end comes into view (an IntersectionObserver)
  readonly scroll = { top: 0, height: 900, visible: 900 };
  onScrolledToEnd?: (page: FakeJourneyPage) => void;
  // a key that reaches no focused element goes to the body, whose listeners see it bubble to the document
  documentKey?: (key: string, page: FakeJourneyPage) => void;
  private selected = false;

  readonly elements: FakeElement[];
  readonly width: number;

  constructor(elements: FakeElement[], width: number) {
    this.elements = elements;
    this.width = width;
  }

  visible(element: FakeElement): boolean {
    return element.shown?.(this) ?? true;
  }

  // the box a wheel over `element` scrolls: its own, else its nearest scrolling ancestor's, else the page's (owner undefined)
  scrollBoxOf(element: FakeElement | undefined): { readonly owner?: number; readonly box: { top: number; height: number; visible: number } } {
    for (let at = element; at; at = at.parent === undefined ? undefined : this.element(at.parent)) {
      if (at.scroll && at.scroll.height > at.scroll.visible) return { owner: at.id, box: at.scroll };
    }
    return { box: this.scroll };
  }

  private element(id: unknown): FakeElement {
    const found = this.elements.find((element) => element.id === id || `node-${element.id}` === id);
    if (!found) throw new Error(`No node ${String(id)}`);
    return found;
  }

  async send(method: JourneyCdpMethod, params: Record<string, unknown>): Promise<unknown> {
    this.sent.push([method, params]);
    switch (method) {
      case 'DOM.getDocument': return { root: { backendNodeId: 1 } };
      case 'Page.getFrameTree': return { frameTree: { frame: { id: 'main' } } };
      case 'Page.createIsolatedWorld': return { executionContextId: 7 };
      case 'Runtime.releaseObjectGroup': return {};
      case 'DOM.scrollIntoViewIfNeeded': return {};
      case 'Accessibility.queryAXTree': {
        const nodes = this.elements.filter((element) => this.visible(element) && (params['accessibleName'] === undefined || element.name === params['accessibleName']) && (params['role'] === undefined || element.role === params['role']));
        return {
          nodes: nodes.map((element) => ({
            ignored: false,
            backendDOMNodeId: element.id,
            role: { value: element.role },
            name: { value: element.name, sources: [{ type: element.nameFrom === 'label' ? 'relatedElement' : element.nameFrom === 'aria-label' ? 'attribute' : 'contents', ...(element.nameFrom === 'aria-label' ? { attribute: 'aria-label' } : {}), value: { value: element.name } }] },
          })),
        };
      }
      case 'Runtime.evaluate': {
        const expression = String(params['expression']);
        if (expression.includes('innerWidth')) return { result: { value: [Math.round(this.width / 2), 450] } };
        if (expression.includes('scrollingElement')) return { result: { value: [this.scroll.top, this.scroll.height, this.scroll.visible] } };
        const wanted = JSON.parse(WANTED.exec(expression)![1]!) as string;
        const exact = !expression.includes('includes(wanted)');
        const matches = (text: string | undefined): boolean => text !== undefined && (exact ? text === wanted : loose(text).includes(loose(wanted)));
        const found = expression.includes("'[placeholder]'")
          ? this.elements.filter((element) => matches(element.placeholder))
          : expression.includes('[aria-labelledby]')
            ? this.elements.filter((element) => (element.nameFrom === 'label' || element.nameFrom === 'aria-label') && matches(element.name))
            : this.elements.filter((element) => matches(element.text));
        return { result: found.length === 1 ? { type: 'object', subtype: 'node', objectId: `node-${found[0]!.id}` } : { type: 'number', value: found.length } };
      }
      case 'DOM.describeNode': return { node: { backendNodeId: this.element(params['objectId']).id } };
      case 'DOM.resolveNode': return { object: { objectId: `node-${this.element(params['backendNodeId']).id}` } };
      case 'DOM.getContentQuads': return { quads: [quadOf(this.element(params['backendNodeId']).id)] };
      case 'DOM.focus':
        this.focused = this.element(params['backendNodeId']).id;
        this.selected = false;
        return {};
      case 'Runtime.callFunctionOn': return { result: { value: this.call(this.element(params['objectId']), String(params['functionDeclaration']), (params['arguments'] as { value: unknown }[]).map((arg) => arg.value)) } };
      case 'Input.dispatchMouseEvent': {
        if (params['type'] === 'mouseWheel') {
          const { owner, box } = this.scrollBoxOf(this.elements.find((element) => element.id * 20 + 5 === params['x']));
          box.top = Math.max(0, Math.min(box.height - box.visible, box.top + Number(params['deltaY'])));
          this.events.push(`wheel ${owner ?? 'page'}`);
          if (owner === undefined && box.top >= box.height - box.visible) this.onScrolledToEnd?.(this);
          return {};
        }
        if (params['type'] !== 'mouseReleased') return {};
        const target = this.elements.find((element) => element.id * 20 + 5 === params['x']);
        this.events.push(`click ${target?.id}`);
        target?.click?.(this);
        return {};
      }
      case 'Input.insertText': {
        const field = this.element(this.focused);
        field.value = this.selected ? String(params['text']) : `${field.value ?? ''}${String(params['text'])}`;
        this.selected = false;
        return {};
      }
      case 'Input.dispatchKeyEvent': {
        if (params['type'] === 'keyUp') return {};
        const key = String(params['key']);
        this.events.push(`key ${key}`);
        const field = this.focused === undefined ? undefined : this.element(this.focused);
        if (key === 'Delete' && field && this.selected) field.value = '';
        if (field?.key) field.key(key, this);
        else this.documentKey?.(key, this);
        return {};
      }
    }
  }

  private call(element: FakeElement, fn: string, args: unknown[]): unknown {
    if (fn.includes('this.focus()')) {
      // an element that takes no focus leaves it where it was, as element.focus() does
      if (FOCUSABLE.has(element.tag)) this.focused = element.id;
      return undefined;
    }
    if (fn.includes('scrollingElement')) {
      const { box } = this.scrollBoxOf(element);
      return [box.top, box.height, box.visible];
    }
    if (fn.includes('elementFromPoint')) return element.covered !== true;
    if (fn.includes('createElement')) {
      this.highlighted.push(element.id);
      return undefined;
    }
    if (fn.includes('checkVisibility')) return this.visible(element);
    if (fn.includes('isContentEditable')) return element.tag === 'input' || element.tag === 'textarea' ? 'text' : 'no';
    if (fn.includes('selectNodeContents')) {
      this.selected = true;
      return undefined;
    }
    if (fn.includes('HTMLSelectElement') && fn.includes('options')) {
      if (element.tag !== 'select') return 'notEditable';
      const option = element.options?.find((candidate) => candidate.value === args[0]) ?? element.options?.find((candidate) => candidate.label === args[0]);
      if (!option) return 'noOption';
      element.value = option.value;
      this.events.push(`change ${element.id}`);
      return 'ok';
    }
    if (fn.includes('textContent')) {
      const text = element.text ?? '';
      return [text.includes(String(args[0])), text];
    }
    if (fn.includes('String(this.value)')) return element.tag === 'input' || element.tag === 'select' || element.tag === 'textarea' ? element.value ?? '' : null;
    throw new Error(`The fake page has no function like ${fn.slice(0, 60)}`);
  }
}

/** The contacts screen of the slice's 11-step journey; the dialog opens on Add contact and closes on Escape unless `stuckDialog`. */
export function contactsPage(width: number, options: { readonly stuckDialog?: boolean; readonly addHiddenBelow?: number } = {}): FakeJourneyPage {
  const open = (page: FakeJourneyPage): boolean => page.state['dialog'] === true;
  const closeOnEscape = (key: string, page: FakeJourneyPage): void => {
    if (key === 'Escape' && !options.stuckDialog) page.state['dialog'] = false;
  };
  return new FakeJourneyPage([
    { id: 2, tag: 'input', role: 'searchbox', name: 'Search contacts', nameFrom: 'aria-label', placeholder: 'Search contacts', value: '' },
    { id: 3, tag: 'ul', role: 'list', name: 'Contacts', nameFrom: 'aria-label', text: 'Grace Hopper grace@example.com Alan Turing alan@example.com' },
    { id: 4, tag: 'span', text: 'Grace Hopper' },
    { id: 5, tag: 'button', role: 'button', name: 'Add contact', nameFrom: 'contents', text: 'Add contact', shown: (page) => page.width >= (options.addHiddenBelow ?? 0), click: (page) => { page.state['dialog'] = true; } },
    { id: 6, tag: 'div', role: 'dialog', name: 'New contact', nameFrom: 'aria-label', shown: open },
    { id: 7, tag: 'input', role: 'textbox', name: 'Name', nameFrom: 'label', value: '', shown: open, key: closeOnEscape },
    { id: 8, tag: 'select', role: 'combobox', name: 'Group', nameFrom: 'label', value: '', options: [{ value: '', label: 'None' }, { value: 'work', label: 'Work' }, { value: 'family', label: 'Family' }], shown: open },
  ], width);
}
