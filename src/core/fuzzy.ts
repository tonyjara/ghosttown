/**
 * Fuzzy matching for the finder dialogs (workspaces, agents).
 *
 * Telescope/fzf shape: the query's characters must appear in order but not
 * adjacently, whitespace splits the query into terms that must ALL match, and
 * the score only decides the ordering — a match is a match. Lists here are
 * tens of items long, so a greedy leftmost scan is plenty.
 */

export interface FuzzyMatch {
  score: number;
  /** Indexes in the haystack the query matched, ascending. */
  positions: number[];
}

const CONSECUTIVE_BONUS = 8;
const WORD_START_BONUS = 6;
const FIRST_CHAR_BONUS = 4;
const EXACT_CASE_BONUS = 1;
const GAP_PENALTY = 1;
/** Between two equally good matches, the shorter label is the better hit. */
const LENGTH_PENALTY = 0.1;

const WORD_SEPARATORS = new Set([" ", "-", "_", "/", ".", ":", "@"]);

function isWordStart(text: string, i: number): boolean {
  return i === 0 || WORD_SEPARATORS.has(text[i - 1]!);
}

/** One term: every char in order, scored on where it landed. */
function matchTerm(term: string, text: string): FuzzyMatch | null {
  const lowerText = text.toLowerCase();
  const positions: number[] = [];
  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of term.toLowerCase()) {
    const at = lowerText.indexOf(ch, from);
    if (at === -1) return null;
    if (at === prev + 1) score += CONSECUTIVE_BONUS;
    else score -= GAP_PENALTY * (at - Math.max(0, prev + 1));
    if (isWordStart(text, at)) score += WORD_START_BONUS;
    if (at === 0) score += FIRST_CHAR_BONUS;
    if (text[at] === term[positions.length]) score += EXACT_CASE_BONUS;
    positions.push(at);
    prev = at;
    from = at + 1;
  }
  return { score, positions };
}

/**
 * Match `query` against `text`. An empty query matches everything with score
 * 0; a query whose terms are not all present returns null.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return { score: 0, positions: [] };
  const positions = new Set<number>();
  let score = -text.length * LENGTH_PENALTY;
  for (const term of terms) {
    const hit = matchTerm(term, text);
    if (!hit) return null;
    score += hit.score;
    for (const p of hit.positions) positions.add(p);
  }
  return { score, positions: [...positions].sort((a, b) => a - b) };
}

/**
 * Filter + rank items by their label. Ties keep the caller's order, so an
 * empty query leaves the list exactly as it came in.
 */
export function fuzzyFilter<T>(
  query: string,
  items: T[],
  label: (item: T) => string,
): Array<{ item: T; match: FuzzyMatch }> {
  return items
    .map((item, index) => ({ item, index, match: fuzzyMatch(query, label(item)) }))
    .filter((r): r is { item: T; index: number; match: FuzzyMatch } => r.match !== null)
    .sort((a, b) => b.match.score - a.match.score || a.index - b.index)
    .map(({ item, match }) => ({ item, match }));
}
