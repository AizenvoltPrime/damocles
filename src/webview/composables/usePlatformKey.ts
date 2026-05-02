interface UserAgentDataLike {
  platform?: string;
}

interface NavigatorWithUserAgentData extends Navigator {
  userAgentData?: UserAgentDataLike;
}

function detectIsMac(): boolean {
  const nav = navigator as NavigatorWithUserAgentData;
  const platform = nav.userAgentData?.platform ?? nav.platform ?? '';
  return /mac/i.test(platform);
}

const isMac = typeof navigator !== 'undefined' && detectIsMac();

export const META_KEY_LABEL = isMac ? '⌘' : 'Ctrl';

export function metaKeyShortcut(letter: string): string {
  return isMac ? `${META_KEY_LABEL}${letter.toUpperCase()}` : `${META_KEY_LABEL}+${letter.toUpperCase()}`;
}
