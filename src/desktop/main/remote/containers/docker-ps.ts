// The running containers an engine lists, and what `inspect` says of one, read as untrusted input: every value that reaches a
// command line or the attach list is checked, and anything else leaves its row out.
import { isContainerId, isContainerName, isContainerPath, isContainerText, isContainerUser, MAX_CONTAINER_TEXT } from '../../../daemon/container-values';

// Rows the attach list shows at most.
export const MAX_LISTED_CONTAINERS = 200;

export interface ListedContainer {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly status: string;
  readonly state: 'running' | 'paused' | 'restarting' | 'other';
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const own = (record: Record<string, unknown>, ...keys: string[]): unknown => keys.map((key) => (Object.hasOwn(record, key) ? record[key] : undefined)).find((value) => value !== undefined);
const STATES = new Set(['running', 'paused', 'restarting']);

// docker prints Names as one comma-joined string, podman as a list; a legacy link alias (`web/db`) may come first, in no fixed
// order, and the container's own name is the one without a slash
function firstName(value: unknown): string | undefined {
  const names: unknown[] = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return names.find(isContainerName);
}

/** `ps --format '{{json .}}'` output, one object a line: the rows that pass every check, at most MAX_LISTED_CONTAINERS. */
export function parsePs(stdout: string): ListedContainer[] {
  const rows: ListedContainer[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === '' || rows.length >= MAX_LISTED_CONTAINERS) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(raw)) continue;
    const id = own(raw, 'ID', 'Id');
    const name = firstName(own(raw, 'Names'));
    const image = own(raw, 'Image');
    const status = own(raw, 'Status');
    const state = own(raw, 'State');
    if (!isContainerId(id) || name === undefined || !isContainerText(image) || image === '' || !isContainerText(status)) continue;
    rows.push({ id, name, image, status, state: typeof state === 'string' && STATES.has(state) ? (state as ListedContainer['state']) : 'other' });
  }
  return rows;
}

export interface InspectedContainer {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  // running and not paused: docker reports a paused container as Running too
  readonly running: boolean;
  readonly paused: boolean;
  // the named volumes mounted, by their folder in the container
  readonly volumes: readonly { readonly name: string; readonly destination: string }[];
  // the user "configured" attaches as: the devcontainer metadata's last remoteUser, else the image's user; absent is root
  readonly user?: string;
  // the configured user is one no exec takes, so attaching as it is refused
  readonly userRefused?: true;
}

// The devcontainer metadata label: a JSON list of objects, of which the last one naming remoteUser wins.
function metadataRemoteUser(label: unknown): string | undefined {
  if (typeof label !== 'string') return undefined;
  let entries: unknown;
  try {
    entries = JSON.parse(label);
  } catch {
    return undefined;
  }
  const list = Array.isArray(entries) ? entries : [entries];
  // the CLI reads an empty remoteUser as unset, so an earlier entry's stands
  const users = list.filter(isRecord).map((entry) => entry['remoteUser']).filter((user) => user !== undefined && user !== '');
  return users.at(-1) as string | undefined;
}

// The named volume mounts inspect lists; a bind or an entry that fails a check is left out.
function volumeMounts(value: unknown): InspectedContainer['volumes'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((mount) => {
    if (!isRecord(mount) || own(mount, 'Type') !== 'volume') return [];
    const name = own(mount, 'Name');
    const destination = own(mount, 'Destination');
    return isContainerText(name) && isContainerPath(destination) ? [{ name, destination }] : [];
  });
}

/** `inspect --type container` output: the containers that pass every check, by full id. */
export function parseInspect(stdout: string): InspectedContainer[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): InspectedContainer[] => {
    if (!isRecord(item)) return [];
    const config = isRecord(item['Config']) ? item['Config'] : {};
    const state = isRecord(item['State']) ? item['State'] : {};
    const id = own(item, 'Id', 'ID');
    const name = typeof item['Name'] === 'string' ? item['Name'].replace(/^\//, '') : undefined;
    const image = own(config, 'Image');
    if (!isContainerId(id) || !isContainerName(name) || !isContainerText(image, MAX_CONTAINER_TEXT)) return [];
    const labels = isRecord(config['Labels']) ? config['Labels'] : {};
    const paused = state['Paused'] === true;
    const found = { id, name, image, running: state['Running'] === true && !paused, paused, volumes: volumeMounts(item['Mounts']) };
    const configured = metadataRemoteUser(labels['devcontainer.metadata']) ?? config['User'];
    if (configured === undefined || configured === '') return [found];
    // a user no exec may take is never replaced by root
    if (!isContainerUser(configured)) return [{ ...found, userRefused: true }];
    return [{ ...found, user: configured }];
  });
}
