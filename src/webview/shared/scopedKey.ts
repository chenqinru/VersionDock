/**
 * Builds a collision-free key from opaque repository ids, revisions and paths.
 * Delimiter-only concatenation is ambiguous when ids themselves contain path
 * separators or colons (notably Windows drive letters and same-path Git/SVN ids).
 */
export function scopedKey(...parts: string[]): string {
  return parts.map(part => `${part.length}:${part}`).join('|');
}
