/**
 * Subsequence-based fuzzy matching in the style VS Code and Sublime Text use
 * for "Quick Open": characters don't need to be contiguous, but runs that
 * are contiguous, or that land right on a word boundary (after a `-`/`_`/`.`
 * /space, or on a camelCase hump), score much higher than scattered matches.
 * This is what makes a query like "conma" prefer `connection-manager.tsx`
 * over an unrelated word that merely contains the same letters in order.
 */

const WORD_SEPARATOR_RE = /[\s\-_./\\:]/;

function isUpperChar(ch: string): boolean {
  return ch >= "A" && ch <= "Z";
}
function isLowerChar(ch: string): boolean {
  return ch >= "a" && ch <= "z";
}
function isDigitChar(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isWordStart(target: string, i: number): boolean {
  if (i === 0) return true;
  const prev = target[i - 1];
  if (WORD_SEPARATOR_RE.test(prev)) return true;
  return isUpperChar(target[i]) && (isLowerChar(prev) || isDigitChar(prev));
}

const CONSECUTIVE_BONUS = 16;
const WORD_START_BONUS = 14;
const CASE_BONUS = 1;
const GAP_PENALTY = 1;
const GAP_PENALTY_CAP = 4;
const LENGTH_PENALTY = 0.5;
// Tolerates one adjacent-letter swap (e.g. "usres" -> "users"), Damerau-Levenshtein
// style, without opening the door to substituting arbitrary characters - that would
// make every sufficiently long string match every query and defeat exclusion.
const TRANSPOSE_BONUS = 12;

const Via = {
  Skip: 0,
  Fresh: 1,
  Consecutive: 2,
  Transpose: 3,
} as const;
type Via = (typeof Via)[keyof typeof Via];

export interface FuzzyMatch {
  /** Higher is better. Comparable across targets of different lengths. */
  score: number;
  /** Indices into `target` that matched the query, in ascending order. */
  indices: number[];
}

/**
 * Match `query` against `target` as an ordered, possibly non-contiguous
 * subsequence. Returns `null` when `query` isn't a subsequence of `target`.
 */
export function fuzzyMatch(target: string, query: string): FuzzyMatch | null {
  const q = query.trim();
  if (!q) return { score: 0, indices: [] };

  const tLen = target.length;
  const qLen = q.length;
  if (qLen > tLen) return null;

  const tLower = target.toLowerCase();
  const qLower = q.toLowerCase();
  const NEG = Number.NEGATIVE_INFINITY;

  const rows = qLen + 1;
  const cols = tLen + 1;
  // M[j][i]: best score of a run ending with query[j-1] matched at target[i-1].
  // B[j][i]: best score matching the first j query chars within target[0..i).
  // argI[j][i]: target index of the last match backing B[j][i] (-1 if none).
  const M: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(NEG));
  const B: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(NEG));
  const argI: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(-1));
  const via: Via[][] = Array.from({ length: rows }, () => new Array(cols).fill(Via.Skip));

  for (let i = 0; i <= tLen; i++) B[0][i] = 0;

  for (let j = 1; j <= qLen; j++) {
    for (let i = 1; i <= tLen; i++) {
      let best = NEG;
      let bestVia: Via = Via.Skip;

      if (qLower[j - 1] === tLower[i - 1]) {
        const caseBonus = q[j - 1] === target[i - 1] ? CASE_BONUS : 0;

        // Continue a run that was matching consecutively.
        if (j > 1 && M[j - 1][i - 1] !== NEG) {
          const val = M[j - 1][i - 1] + CONSECUTIVE_BONUS + caseBonus;
          if (val > best) {
            best = val;
            bestVia = Via.Consecutive;
          }
        }

        // Or jump here from the best match of the previous query chars so far.
        const prevBest = j === 1 ? 0 : B[j - 1][i - 1];
        if (prevBest !== NEG) {
          const prevPos = j === 1 ? -1 : argI[j - 1][i - 1];
          const gap = i - 1 - prevPos - 1;
          const boundary = isWordStart(target, i - 1) ? WORD_START_BONUS : 0;
          const val = prevBest + boundary + caseBonus - Math.min(gap, GAP_PENALTY_CAP) * GAP_PENALTY;
          if (val > best) {
            best = val;
            bestVia = Via.Fresh;
          }
        }
      }

      // Or swap: the last two query chars appear reversed in the target
      // right here, e.g. query "usres" landing on target "us[er]s".
      if (j > 1 && i > 1 && qLower[j - 2] === tLower[i - 1] && qLower[j - 1] === tLower[i - 2]) {
        const prevBest = j === 2 ? 0 : B[j - 2][i - 2];
        if (prevBest !== NEG) {
          const prevPos = j === 2 ? -1 : argI[j - 2][i - 2];
          const gap = i - 2 - prevPos - 1;
          const val = prevBest + TRANSPOSE_BONUS - Math.min(gap, GAP_PENALTY_CAP) * GAP_PENALTY;
          if (val > best) {
            best = val;
            bestVia = Via.Transpose;
          }
        }
      }

      M[j][i] = bestVia === Via.Consecutive || bestVia === Via.Fresh ? best : NEG;
      via[j][i] = bestVia;
      if (best >= B[j][i - 1]) {
        B[j][i] = best;
        argI[j][i] = i - 1;
      } else {
        B[j][i] = B[j][i - 1];
        argI[j][i] = argI[j][i - 1];
        via[j][i] = Via.Skip;
      }
    }
  }

  const total = B[qLen][tLen];
  if (total === NEG) return null;

  const indices: number[] = [];
  let j = qLen;
  let pos = argI[qLen][tLen];
  while (j > 0) {
    const step = via[j][pos + 1];
    if (step === Via.Transpose) {
      indices.push(pos, pos - 1);
      j -= 2;
      pos = j === 0 ? -1 : argI[j][pos - 1];
    } else if (step === Via.Consecutive) {
      indices.push(pos);
      j -= 1;
      pos = pos - 1;
    } else {
      indices.push(pos);
      j -= 1;
      pos = j === 0 ? -1 : argI[j][pos];
    }
  }
  indices.reverse();

  return { score: total - LENGTH_PENALTY * (tLen - qLen), indices };
}

/** Group matched indices into alternating matched/unmatched text runs, for rendering `<mark>` highlights. */
export function matchSegments(text: string, indices: readonly number[]): { text: string; matched: boolean }[] {
  if (indices.length === 0) return text ? [{ text, matched: false }] : [];

  const segments: { text: string; matched: boolean }[] = [];
  let cursor = 0;
  let run = 0;
  while (run < indices.length) {
    if (indices[run] > cursor) segments.push({ text: text.slice(cursor, indices[run]), matched: false });
    let end = run + 1;
    while (end < indices.length && indices[end] === indices[end - 1] + 1) end++;
    segments.push({ text: text.slice(indices[run], indices[end - 1] + 1), matched: true });
    cursor = indices[end - 1] + 1;
    run = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), matched: false });
  return segments;
}

export interface FuzzySearchResult<T> {
  item: T;
  refIndex: number;
  score: number;
}

type KeyOption = string | { name: string; weight?: number };

export interface FuzzySearchOptions {
  keys?: KeyOption[];
}

function matchScore(item: unknown, search: string, keys: KeyOption[] | undefined): number | null {
  if (!keys) {
    return typeof item === "string" ? fuzzyMatch(item, search)?.score ?? null : null;
  }

  let best: number | null = null;
  for (const key of keys) {
    const name = typeof key === "string" ? key : key.name;
    const weight = typeof key === "string" ? 1 : key.weight ?? 1;
    const value = (item as Record<string, unknown>)[name];
    if (typeof value !== "string" || !value) continue;

    const match = fuzzyMatch(value, search);
    if (!match) continue;
    const weighted = match.score * weight;
    if (best === null || weighted > best) best = weighted;
  }
  return best;
}

/** Search and rank a collection using the application's shared fuzzy-match defaults. */
export function fuzzySearchResults<T>(
  items: readonly T[],
  query: string,
  options: FuzzySearchOptions = {},
): FuzzySearchResult<T>[] {
  const search = query.trim();
  if (!search) return items.map((item, refIndex) => ({ item, refIndex, score: 0 }));

  const results: FuzzySearchResult<T>[] = [];
  items.forEach((item, refIndex) => {
    const best = matchScore(item, search, options.keys);
    if (best === null) return;
    results.push({ item, refIndex, score: -best });
  });

  results.sort((a, b) => a.score - b.score || a.refIndex - b.refIndex);
  return results;
}

export function fuzzySearch<T>(
  items: readonly T[],
  query: string,
  options: FuzzySearchOptions = {},
): T[] {
  return fuzzySearchResults(items, query, options).map(({ item }) => item);
}
