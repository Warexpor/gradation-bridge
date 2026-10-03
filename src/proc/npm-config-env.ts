/**
 * npm copies any `npm_config_*` variable into its config, and the match is
 * case-insensitive. `script-shell` (any spelling) replaces the shell that
 * runs an approved `npm test`.
 */
export function isNpmConfigEnv(name: string): boolean {
  const prefix = "npm_config_";
  return name.length >= prefix.length && name.slice(0, prefix.length).toLowerCase() === prefix;
}
