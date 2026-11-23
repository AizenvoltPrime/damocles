// Id of the <style> element carrying PanelHost.themeCssSource() in the panel HTML; the desktop panel preload replaces its text.
export const HOST_THEME_STYLE_ID = 'damocles-host-theme';
// Id of the desktop <style> element after it carrying the trusted palette (PanelTheme.trustedCss), which the preloads replace too.
export const HOST_TRUSTED_STYLE_ID = 'damocles-host-trusted';
// Id of the desktop <style> element after the trusted one carrying a theme's sanitized CSS (PanelTheme.customCss); only a preload writes it, through textContent, never main's HTML.
export const HOST_THEME_USER_STYLE_ID = 'damocles-theme-user';
