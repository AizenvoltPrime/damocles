// esbuild's text loader (esbuild.config.mjs desktopMainOptions) and vitest's stage-script-text plugin import these as text.
declare module '*.sh' {
  const text: string;
  export default text;
}

declare module '*.ps1' {
  const text: string;
  export default text;
}
