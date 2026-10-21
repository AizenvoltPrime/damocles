/** The entries of the `.asar` archive the e2e specs write with writeAsar: a package.json and a script, as an app archive holds. */
export const ARCHIVE: Readonly<Record<string, string>> = { 'package.json': '{"name":"e2e-archive"}', 'dist/main.js': 'module.exports = 1;\n' };
