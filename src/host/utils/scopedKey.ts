/**
 * Builds a collision-free key from opaque repository ids, revisions and paths.
 * Delimiter-only concatenation is ambiguous because each value may legally
 * contain the delimiter (notably colons in POSIX filenames and repository ids).
 */
export function scopedKey(...parts: string[]): string {
  return parts.map(part => `${part.length}:${part}`).join('|');
}
