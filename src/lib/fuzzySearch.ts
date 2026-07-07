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
 * Cheap necessary condition for a match: every query character (by lowercase
 * count) must appear at least as often in the target. A transposition only
 * reorders two adjacent target characters, it never invents one, so this can
 * never reject a true match - but for a large candidate list it lets us skip
 * the O(qLen*tLen) table below for the (common) targets that can't possibly
 * match, without allocating anything but a small count map.
 */
function hasRequiredChars(tLower: string, qLower: string): boolean {
  const need = new Map<string, number>();
  for (let i = 0; i < qLower.length; i++) {
    const c = qLower[i];
    need.set(c, (need.get(c) ?? 0) + 1);
  }
  let remaining = qLower.length;
  for (let i = 0; i < tLower.length && remaining > 0; i++) {
    const c = tLower[i];
    const n = need.get(c);
    if (n) {
      need.set(c, n - 1);
      remaining--;
    }
  }
  return remaining === 0;
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
  if (!hasRequiredChars(tLower, qLower)) return null;

  const NEG = Number.NEGATIVE_INFINITY;

  const rows = qLen + 1;
  const cols = tLen + 1;
  // Flat (rows*cols) typed arrays instead of an array of arrays: this table is
  // rebuilt from scratch for every target, so keeping it to a handful of
  // single-buffer allocations (rather than `rows` separate array objects)
  // matters when matching against thousands of candidates per keystroke.
  // M[j*cols+i]: best score of a run ending with query[j-1] matched at target[i-1].
  // B[j*cols+i]: best score matching the first j query chars within target[0..i).
  // argI[j*cols+i]: target index of the last match backing B[j][i] (-1 if none).
  const M = new Float64Array(rows * cols).fill(NEG);
  const B = new Float64Array(rows * cols).fill(NEG);
  const argI = new Int32Array(rows * cols).fill(-1);
  const via = new Uint8Array(rows * cols); // Via.Skip === 0

  for (let i = 0; i <= tLen; i++) B[i] = 0;

  for (let j = 1; j <= qLen; j++) {
    const rowOff = j * cols;
    const prevRowOff = rowOff - cols;
    for (let i = 1; i <= tLen; i++) {
      let best = NEG;
      let bestVia: Via = Via.Skip;

      if (qLower[j - 1] === tLower[i - 1]) {
        const caseBonus = q[j - 1] === target[i - 1] ? CASE_BONUS : 0;

        // Continue a run that was matching consecutively.
        if (j > 1 && M[prevRowOff + i - 1] !== NEG) {
          const val = M[prevRowOff + i - 1] + CONSECUTIVE_BONUS + caseBonus;
          if (val > best) {
            best = val;
            bestVia = Via.Consecutive;
          }
        }

        // Or jump here from the best match of the previous query chars so far.
        const prevBest = j === 1 ? 0 : B[prevRowOff + i - 1];
        if (prevBest !== NEG) {
          const prevPos = j === 1 ? -1 : argI[prevRowOff + i - 1];
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
        const prevRow2Off = rowOff - 2 * cols;
        const prevBest = j === 2 ? 0 : B[prevRow2Off + i - 2];
        if (prevBest !== NEG) {
          const prevPos = j === 2 ? -1 : argI[prevRow2Off + i - 2];
          const gap = i - 2 - prevPos - 1;
          const val = prevBest + TRANSPOSE_BONUS - Math.min(gap, GAP_PENALTY_CAP) * GAP_PENALTY;
          if (val > best) {
            best = val;
            bestVia = Via.Transpose;
          }
        }
      }

      M[rowOff + i] = bestVia === Via.Consecutive || bestVia === Via.Fresh ? best : NEG;
      via[rowOff + i] = bestVia;
      if (best >= B[rowOff + i - 1]) {
        B[rowOff + i] = best;
        argI[rowOff + i] = i - 1;
      } else {
        B[rowOff + i] = B[rowOff + i - 1];
        argI[rowOff + i] = argI[rowOff + i - 1];
        via[rowOff + i] = Via.Skip;
      }
    }
  }

  const total = B[qLen * cols + tLen];
  if (total === NEG) return null;

  const indices: number[] = [];
  let j = qLen;
  let pos = argI[qLen * cols + tLen];
  while (j > 0) {
    const step = via[j * cols + pos + 1];
    if (step === Via.Transpose) {
      indices.push(pos, pos - 1);
      j -= 2;
      pos = j === 0 ? -1 : argI[j * cols + pos - 1];
    } else if (step === Via.Consecutive) {
      indices.push(pos);
      j -= 1;
      pos = pos - 1;
    } else {
      indices.push(pos);
      j -= 1;
      pos = j === 0 ? -1 : argI[j * cols + pos];
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
  /**
   * Matched indices for the first configured key (or for the item itself in
   * plain-string mode) - whichever field callers display and highlight.
   * Exposed so rendering can reuse this instead of re-running fuzzyMatch on
   * the same string it just matched here.
   */
  indices: number[];
}

type KeyOption = string | { name: string; weight?: number };

export interface FuzzySearchOptions {
  keys?: KeyOption[];
}

function matchScore(
  item: unknown,
  search: string,
  keys: KeyOption[] | undefined,
): { score: number; indices: number[] } | null {
  if (!keys) {
    if (typeof item !== "string") return null;
    const match = fuzzyMatch(item, search);
    return match ? { score: match.score, indices: match.indices } : null;
  }

  let best: number | null = null;
  let primaryIndices: number[] = [];
  keys.forEach((key, keyIndex) => {
    const name = typeof key === "string" ? key : key.name;
    const weight = typeof key === "string" ? 1 : key.weight ?? 1;
    const value = (item as Record<string, unknown>)[name];
    if (typeof value !== "string" || !value) return;

    const match = fuzzyMatch(value, search);
    if (!match) return;
    if (keyIndex === 0) primaryIndices = match.indices;
    const weighted = match.score * weight;
    if (best === null || weighted > best) best = weighted;
  });
  return best === null ? null : { score: best, indices: primaryIndices };
}

/** Search and rank a collection using the application's shared fuzzy-match defaults. */
export function fuzzySearchResults<T>(
  items: readonly T[],
  query: string,
  options: FuzzySearchOptions = {},
): FuzzySearchResult<T>[] {
  const search = query.trim();
  if (!search) return items.map((item, refIndex) => ({ item, refIndex, score: 0, indices: [] }));

  const results: FuzzySearchResult<T>[] = [];
  items.forEach((item, refIndex) => {
    const best = matchScore(item, search, options.keys);
    if (best === null) return;
    results.push({ item, refIndex, score: -best.score, indices: best.indices });
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
