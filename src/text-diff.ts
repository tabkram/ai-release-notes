/**
 * What changed between two versions of a file, line by line.
 *
 * A revision is accepted or rejected on what it did to the words, so the lines
 * both versions share are found first and only what is left is reported as
 * removed or added. Release notes are short documents, which is what makes the
 * exact comparison affordable; past a bound the lines are compared as sets
 * instead, which reports the same lines in a less readable order.
 */

export type DiffKind = "added" | "removed" | "unchanged";

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

/** Above this many lines on either side, the exact comparison is skipped. */
const EXACT_COMPARISON_LIMIT = 2000;

/** Compare two texts line by line, in reading order. */
export function diffLines(before: string, after: string): DiffLine[] {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);

  return beforeLines.length > EXACT_COMPARISON_LIMIT || afterLines.length > EXACT_COMPARISON_LIMIT
    ? compareAsSets(beforeLines, afterLines)
    : walkCommonSubsequence(beforeLines, afterLines);
}

/** The lines a revision removed and added, in reading order. */
export function changedLines(before: string, after: string): DiffLine[] {
  return diffLines(before, after).filter((line) => line.kind !== "unchanged");
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

/**
 * The longest run of lines both versions keep, and everything around it.
 *
 * The table holds the length of that run for every pair of positions; walking
 * back through it from the end pairs each kept line with itself, so a line that
 * only moved is reported once as removed and once as added rather than as a
 * rewrite of whatever now sits in its place.
 */
function walkCommonSubsequence(before: string[], after: string[]): DiffLine[] {
  const lengths: number[][] = Array.from(
    { length: before.length + 1 },
    () => new Array<number>(after.length + 1).fill(0)
  );

  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) {
      lengths[left][right] = before[left] === after[right]
        ? lengths[left + 1][right + 1] + 1
        : Math.max(lengths[left + 1][right], lengths[left][right + 1]);
    }
  }

  const diff: DiffLine[] = [];
  let left = 0;
  let right = 0;
  while (left < before.length && right < after.length) {
    if (before[left] === after[right]) {
      diff.push({ kind: "unchanged", text: before[left] });
      left += 1;
      right += 1;
    } else if (lengths[left + 1][right] >= lengths[left][right + 1]) {
      diff.push({ kind: "removed", text: before[left] });
      left += 1;
    } else {
      diff.push({ kind: "added", text: after[right] });
      right += 1;
    }
  }

  for (; left < before.length; left += 1) diff.push({ kind: "removed", text: before[left] });
  for (; right < after.length; right += 1) diff.push({ kind: "added", text: after[right] });

  return diff;
}

/** Every removed line, then every added one: the fallback for a long file. */
function compareAsSets(before: string[], after: string[]): DiffLine[] {
  const kept = new Set(after);
  const known = new Set(before);
  return [
    ...before.filter((line) => !kept.has(line)).map((text): DiffLine => ({ kind: "removed", text })),
    ...after.filter((line) => !known.has(line)).map((text): DiffLine => ({ kind: "added", text })),
  ];
}
