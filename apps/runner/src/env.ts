/** Copies the named variables that are set and non-empty; everything else stays behind. */
export const pickEnv = (
  names: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const picked: Record<string, string> = {};
  for (const name of names) {
    const value = env[name];
    if (value) picked[name] = value;
  }
  return picked;
};
