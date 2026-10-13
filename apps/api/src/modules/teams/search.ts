/** Find a team search term handling (Architecture Q5): what the user types is matched literally. */

/** Escapes `\`, then `%` and `_`, so none of them acts as a LIKE wildcard (the backslash is LIKE's default escape). */
export function escapeLikePattern(term: string): string {
  return term.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

/** `%term%` with the term escaped: a substring match. */
export function containsPattern(term: string): string {
  return `%${escapeLikePattern(term)}%`;
}
