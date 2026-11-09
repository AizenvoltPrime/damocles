import type { PlatformPath } from 'node:path';
import { isDesignId, isDesignScreenFile } from '../../../shared/design-paths';
import { authorityKeyOfProject, pathFor } from '../../../shared/project-location';

// The remote server's wire feature for an editor tab's Open preview on a design's screen (design.previewScreen).
export const DESIGN_PREVIEW_SCREEN_FEATURE = 'design.previewScreen';

/**
 * Whether `filePath`, in `flavor`'s path rules, ends in `.damocles/designs/<designId>/screens/<name>.html`, the shape of a
 * screen in a host's designs folder (core's DAMOCLES_DESIGNS_DIR). It only decides what the tab menu offers, so a home
 * reached through a link still matches; core checks the path against its own designs folder.
 */
export function isDesignScreenPath(flavor: PlatformPath, filePath: string): boolean {
  const segments = flavor.normalize(filePath).split(flavor.sep);
  if (segments.length < 6) return false;
  const [dataFolder, designs, designId, screens, name] = segments.slice(-5) as [string, string, string, string, string];
  // Windows compares names in any case, as core's designs folder check does there
  const named = (segment: string, expected: string): boolean => (flavor.sep === '\\' ? segment.toLowerCase() === expected : segment === expected);
  return named(dataFolder, '.damocles') && named(designs, 'designs') && isDesignId(designId) && isDesignScreenFile(`${screens}/${name}`);
}

/** What main knows of an authority, the facts the Open preview offer reads. */
export interface DesignScreenHosts {
  // a remote host's connection features; undefined while it is not connected
  readonly features: (authority: string) => readonly string[] | undefined;
  readonly osOf: (authority: string) => NodeJS.Platform | undefined;
}

/** The authority of the file at `location`: its host, else its project's, else this computer. */
export function authorityOfLocation(location: { readonly host?: string; readonly projectKey?: string }): string {
  return location.host ?? (location.projectKey === undefined ? 'local' : authorityKeyOfProject(location.projectKey));
}

/**
 * The authority whose core may open the preview of the design screen at `location`: the file's own, for a path shaped as a
 * screen of a designs folder, on a remote host only while its server serves design.previewScreen; undefined for any other
 * file. Only facts that change with a publish decide it; the click finds the core, and the core checks the path.
 */
export function designScreenAuthority(location: { readonly path: string; readonly host?: string; readonly projectKey?: string }, hosts: DesignScreenHosts): string | undefined {
  // most tabs are no design file, and this runs for every file tab on every publish
  if (!location.path.toLowerCase().includes('.damocles')) return undefined;
  const authority = authorityOfLocation(location);
  if (authority !== 'local' && !hosts.features(authority)?.includes(DESIGN_PREVIEW_SCREEN_FEATURE)) return undefined;
  const os = hosts.osOf(authority);
  return os !== undefined && isDesignScreenPath(pathFor({ os }), location.path) ? authority : undefined;
}
