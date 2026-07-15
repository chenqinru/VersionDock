export function baseNameFromPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.replace(/[\\/]+$/, '');
  if (!trimmed) return value;
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? trimmed;
}
