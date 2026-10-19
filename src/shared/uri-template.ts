// RFC 6570 URI templates (all four levels) for the string and list values a template form supplies. The parser follows
// VS Code's src/vs/base/common/uriTemplate.ts (MIT, Copyright (c) Microsoft Corporation; see THIRD-PARTY-NOTICES.md),
// except that an expression the RFC's section 3 finds invalid passes through unexpanded, as that section asks;
// expansion follows the RFC's appendix A, encoding as UTF-8.

export interface UriTemplateVariable {
  readonly name: string;
  // `*`: a list value expands one item per separator
  readonly explode: boolean;
  // in a `;`, `?` or `&` expression, whose values a URI may leave out
  readonly named: boolean;
  // `:n`: a string value keeps its first n characters
  readonly prefixLength?: number;
}

interface UriTemplateExpression {
  readonly expression: string;
  readonly operator: string;
  readonly variables: readonly UriTemplateVariable[];
}

export interface UriTemplate {
  readonly template: string;
  readonly components: readonly (UriTemplateExpression | string)[];
}

export type UriTemplateValue = string | readonly string[];

interface OperatorRule {
  readonly first: string;
  readonly separator: string;
  readonly named: boolean;
  // what a named variable with an empty value expands to after its name
  readonly ifEmpty: string;
  readonly allowReserved: boolean;
}

// RFC 6570 appendix A.
const OPERATORS: Readonly<Record<string, OperatorRule>> = {
  '': { first: '', separator: ',', named: false, ifEmpty: '', allowReserved: false },
  '+': { first: '', separator: ',', named: false, ifEmpty: '', allowReserved: true },
  '.': { first: '.', separator: '.', named: false, ifEmpty: '', allowReserved: false },
  '/': { first: '/', separator: '/', named: false, ifEmpty: '', allowReserved: false },
  ';': { first: ';', separator: ';', named: true, ifEmpty: '', allowReserved: false },
  '?': { first: '?', separator: '&', named: true, ifEmpty: '=', allowReserved: false },
  '&': { first: '&', separator: '&', named: true, ifEmpty: '=', allowReserved: false },
  '#': { first: '#', separator: ',', named: false, ifEmpty: '', allowReserved: true },
};

export function parseUriTemplate(template: string): UriTemplate {
  const components: (UriTemplateExpression | string)[] = [];
  const regex = /\{([^{}]+)\}/g;
  let match: RegExpExecArray | null;
  let lastPos = 0;
  while ((match = regex.exec(template))) {
    const expression = match[0];
    const inner = match[1]!;
    const literal = template.slice(lastPos, match.index);
    components.push(literal);
    lastPos = match.index + expression.length;
    // An earlier unclosed '{' opens the expression this one sits in, which a brace inside makes invalid.
    if (literal.includes('{')) {
      components.push(expression);
      continue;
    }
    const operator = Object.hasOwn(OPERATORS, inner[0]!) ? inner[0]! : '';
    const named = OPERATORS[operator]!.named;
    const variables = inner.slice(operator.length).split(',').map((spec): UriTemplateVariable => {
      let name = spec;
      const explode = name.endsWith('*');
      if (explode) name = name.slice(0, -1);
      const prefix = /^(.*?):(\d+)$/.exec(name);
      if (prefix) name = prefix[1]!;
      return { name, explode, named, ...(prefix ? { prefixLength: parseInt(prefix[2]!, 10) } : {}) };
    });
    components.push(variables.some((variable) => variable.name === '') ? expression : { expression, operator, variables });
  }
  components.push(template.slice(lastPos));
  return { template, components };
}

/** Each variable once, in template order. */
export function uriTemplateVariables(template: UriTemplate): UriTemplateVariable[] {
  const seen = new Set<string>();
  const variables: UriTemplateVariable[] = [];
  for (const component of template.components) {
    if (typeof component === 'string') continue;
    for (const variable of component.variables) {
      if (seen.has(variable.name)) continue;
      seen.add(variable.name);
      variables.push(variable);
    }
  }
  return variables;
}

/** An undefined value or an empty list is left out of its expression. */
export function resolveUriTemplate(template: UriTemplate, values: Readonly<Record<string, UriTemplateValue | undefined>>): string {
  return template.components.map((component) => (typeof component === 'string' ? component : expand(component, values))).join('');
}

function expand(component: UriTemplateExpression, values: Readonly<Record<string, UriTemplateValue | undefined>>): string {
  const rule = OPERATORS[component.operator]!;
  const encode = (text: string): string => encodeValue(text, rule.allowReserved);
  const named = (name: string, encoded: string): string => (encoded === '' ? `${name}${rule.ifEmpty}` : `${name}=${encoded}`);
  const parts: string[] = [];
  for (const variable of component.variables) {
    const value = Object.hasOwn(values, variable.name) ? values[variable.name] : undefined;
    if (value === undefined || (typeof value !== 'string' && value.length === 0)) continue;
    if (typeof value === 'string') {
      const kept = variable.prefixLength === undefined ? value : Array.from(value).slice(0, variable.prefixLength).join('');
      parts.push(rule.named ? named(variable.name, encode(kept)) : encode(kept));
    } else if (!variable.explode) {
      const joined = value.map(encode).join(',');
      parts.push(rule.named ? named(variable.name, joined) : joined);
    } else {
      parts.push(value.map((item) => (rule.named ? named(variable.name, encode(item)) : encode(item))).join(rule.separator));
    }
  }
  return parts.length > 0 ? rule.first + parts.join(rule.separator) : '';
}

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;
const RESERVED = /^[:/?#[\]@!$&'()*+,;=]$/;
const HEX_PAIR = /^[0-9A-Fa-f]{2}$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function encodeValue(text: string, allowReserved: boolean): string {
  const chars = Array.from(text.replace(LONE_SURROGATE, '\uFFFD'));
  let out = '';
  chars.forEach((char, index) => {
    // Reserved expansion passes a pct-encoded triplet through.
    const triplet = char === '%' && HEX_PAIR.test(`${chars[index + 1] ?? ''}${chars[index + 2] ?? ''}`);
    if (UNRESERVED.test(char) || (allowReserved && (RESERVED.test(char) || triplet))) out += char;
    else if (char.charCodeAt(0) < 0x80) out += `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
    else out += encodeURIComponent(char);
  });
  return out;
}
