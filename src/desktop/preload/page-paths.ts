// Where main serves the desktop popup window's page (D52), which loads the overlay bundle; main routes it and the bundle
// picks its app by it. Imports nothing, so main and the page can both load it.
export const NOTIFIER_PAGE_PATH = '/notifier/index.html';
// Where main serves the theme editor dock's page, which loads the overlay bundle at its editor route.
export const THEME_EDITOR_PAGE_PATH = '/theme-editor/index.html';
