import LineBreaker from 'linebreak';
import { fontFor, toWinAnsi } from './fonts';
import type { TextStyle } from './style';
import type { FontMetrics } from './writer';

export interface TextLine {
  readonly text: string;
  readonly width: number;
  /** Top of the line box. */
  readonly y: number;
}

export interface TextBlock {
  readonly lines: readonly TextLine[];
  readonly width: number;
  readonly height: number;
}

const MAX_TEXT_LENGTH = 1_048_576;
// yoga-layout's MeasureMode.Undefined: no width constraint.
const MEASURE_MODE_UNDEFINED = 0;
// How far over `maxWidth` the summed character widths may be and still be tried by measuring.
const KERNING_SLACK = 1.25;

/** One input text, prepared once per render: what is drawn and where a line may break. */
export interface PreparedText {
  /** The WinAnsi text with its whitespace collapsed. */
  readonly collapsed: string;
  readonly breaks: readonly number[];
  /** Characters outside WinAnsi that became `?`; reported again on every layout of the text. */
  readonly replaced: readonly string[];
  /** Prefix sums of the character widths, per font and size (`"<font> <size>"`). */
  readonly prefixes: Map<string, Float64Array>;
  /** Laid-out blocks, per font, size, line height and width (`"<font> <size> <lineHeight> <width>"`). */
  readonly blocks: Map<string, TextBlock>;
}

/**
 * Text measuring work reused within one render. Yoga calls a text's measure function many times
 * (once per available width, in every layout pass), the final layout wraps the text once more,
 * and table cells repeat the same words; without the cache each call collapses, breaks and
 * measures the text again.
 *
 * - `texts`: per input text, its collapsed form, break positions, prefix sums and blocks.
 * - `widths`: per font and size (`"<font> <size>"`), the drawn width of every string measured.
 *
 * Create one per render with `createTextCache` and use it with that render's metrics only: it
 * lives in the render's `LayoutContext` and is never module state, so renders share nothing. It
 * holds one entry per distinct measure or layout, so it grows no faster than the render's work.
 */
export interface TextCache {
  readonly texts: Map<string, PreparedText>;
  readonly widths: Map<string, Map<string, number>>;
}

export function createTextCache(): TextCache {
  return { texts: new Map(), widths: new Map() };
}

function assertTextSize(text: string): void {
  if (text.length > MAX_TEXT_LENGTH) throw new Error('ngpdf: text longer than 1 MB');
}

/** CSS `white-space: normal`: runs of space, tab and line breaks become one space; ends trimmed. */
function collapseWhitespace(text: string): string {
  return text.replace(/[ \t\r\n]+/g, ' ').trim();
}

/** Positions in `text` after which a line may break (UAX #14); the last one is `text.length`. */
function breakPositions(text: string): number[] {
  const positions: number[] = [];
  const breaker = new LineBreaker(text);
  for (let next = breaker.nextBreak(); next; next = breaker.nextBreak()) {
    positions.push(next.position);
  }
  return positions;
}

/** The largest `index` in `[low, high]` where `holds(index)`, or `low - 1`; `holds` is monotone. */
function lastWhere(low: number, high: number, holds: (index: number) => boolean): number {
  let lo = low - 1;
  let hi = high;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (holds(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Breaks `text` into lines no wider than `maxWidth`, at Unicode line break opportunities. A word
 * wider than `maxWidth` is split at the last character that fits (at least one per line).
 *
 * Every line's drawn width, `widthOf(line.text)`, is at most `maxWidth`, unless a single character
 * is wider than `maxWidth`. Kerning makes the drawn width differ from the sum of the character
 * widths, so the sums (prefix sums, built once) only give a starting guess for each line's end, taken up
 * to 25% over `maxWidth` to allow for kerning that narrows the text;
 * the guess is then measured for real and, if it overflows, the end is found by binary search over
 * the candidate ends, measuring each candidate. A line is never given up without being measured.
 *
 * Cost: O(n) for the prefix sums and the break positions, then per line O(log n) steps for the
 * guess plus O(log k) measures of at most k characters (k is about one line), so O(n log k) in the
 * worst case. Every line takes at least one character, so no text is lost.
 *
 * With a render's `cache`, the collapsed text and its break positions are made once per text, the
 * prefix sums once per text, font and size, each string is measured once per font and size, and
 * the same text at the same width is laid out once; the block is then shared, and frozen.
 */
export function layoutText(
  text: string,
  style: TextStyle,
  maxWidth: number,
  metrics: FontMetrics,
  warn: (chars: string[]) => void = () => undefined,
  cache: TextCache = createTextCache(),
): TextBlock {
  assertTextSize(text);
  const prepared = prepare(text, cache);
  if (prepared.replaced.length > 0) warn([...prepared.replaced]);
  const font = fontFor(style);
  const size = style.fontSize;
  const fontKey = `${font} ${String(size)}`;
  const blockKey = `${fontKey} ${String(style.lineHeight)} ${String(maxWidth)}`;
  let block = prepared.blocks.get(blockKey);
  if (!block) {
    let widths = cache.widths.get(fontKey);
    if (!widths) {
      widths = new Map();
      cache.widths.set(fontKey, widths);
    }
    const known = widths;
    const widthOf = (chunk: string): number => {
      let width = known.get(chunk);
      if (width === undefined) {
        width = metrics.widthOf(chunk, font, size);
        known.set(chunk, width);
      }
      return width;
    };
    let prefix = prepared.prefixes.get(fontKey);
    if (!prefix) {
      prefix = prefixWidths(prepared.collapsed, widthOf);
      prepared.prefixes.set(fontKey, prefix);
    }
    block = breakLines(prepared, prefix, size * style.lineHeight, maxWidth, widthOf);
    prepared.blocks.set(blockKey, block);
  }
  return block;
}

/** The text's prepared form from `cache`, made on first use. */
function prepare(text: string, cache: TextCache): PreparedText {
  let prepared = cache.texts.get(text);
  if (!prepared) {
    let replaced: readonly string[] = [];
    const collapsed = collapseWhitespace(
      toWinAnsi(text, (chars) => {
        replaced = chars;
      }),
    );
    prepared = {
      collapsed,
      breaks: collapsed.length === 0 ? [] : breakPositions(collapsed),
      replaced,
      prefixes: new Map(),
      blocks: new Map(),
    };
    cache.texts.set(text, prepared);
  }
  return prepared;
}

/** prefix[i] is the summed width of the first i characters (all single UTF-16 units after WinAnsi). */
function prefixWidths(collapsed: string, widthOf: (chunk: string) => number): Float64Array {
  const prefix = new Float64Array(collapsed.length + 1);
  for (let i = 0; i < collapsed.length; i++) {
    prefix[i + 1] = (prefix[i] ?? 0) + widthOf(collapsed.charAt(i));
  }
  return prefix;
}

/** The lines of `prepared` in `maxWidth`, frozen because the cache hands the block out again. */
function breakLines(
  prepared: PreparedText,
  prefix: Float64Array,
  lineHeight: number,
  maxWidth: number,
  widthOf: (chunk: string) => number,
): TextBlock {
  const { collapsed, breaks } = prepared;
  const length = collapsed.length;

  /** The end of the text to draw for a line `[start, end)`: a trailing space is not drawn. */
  const drawnEnd = (end: number): number => (collapsed.charCodeAt(end - 1) === 32 ? end - 1 : end);
  const guess = (start: number, end: number): number =>
    (prefix[drawnEnd(end)] ?? 0) - (prefix[start] ?? 0);
  const measure = (start: number, end: number): number =>
    widthOf(collapsed.slice(start, drawnEnd(end)));
  const fits = (start: number, end: number): boolean => measure(start, end) <= maxWidth;

  /** The largest end in `[low, high]` that fits, given that `low` fits and `high` does not. */
  const narrow = (low: number, high: number, endOf: (index: number) => number, start: number) =>
    endOf(lastWhere(low, high - 1, (index) => fits(start, endOf(index))));

  // Kerning mostly narrows text, so a line can hold a little more than its character sum says.
  const guessLimit = maxWidth * KERNING_SLACK;

  const lines: TextLine[] = [];
  let start = 0;
  let nextBreak = 0;
  while (start < length) {
    // A piece can hold an inner space (no break before some punctuation): no line starts with one.
    if (collapsed.charCodeAt(start) === 32) {
      start++;
      continue;
    }
    while ((breaks[nextBreak] ?? length) <= start) nextBreak++;
    const firstEnd = breaks[nextBreak] ?? length;

    // Whole words: the last break whose summed width fits, checked and narrowed by measuring.
    const lastGuess = lastWhere(
      nextBreak,
      breaks.length - 1,
      (index) => guess(start, breaks[index] ?? length) <= guessLimit,
    );
    let end = -1;
    if (lastGuess >= nextBreak) {
      const guessEnd = breaks[lastGuess] ?? length;
      if (fits(start, guessEnd)) end = guessEnd;
      else if (fits(start, firstEnd))
        end = narrow(nextBreak, lastGuess, (i) => breaks[i] ?? length, start);
    }

    if (end < 0) {
      // The first word is wider than the box: split it at the last character that fits.
      const lastChar = lastWhere(start + 1, firstEnd, (index) => guess(start, index) <= guessLimit);
      const guessEnd = Math.max(lastChar, start + 1);
      if (fits(start, guessEnd) || guessEnd === start + 1) end = guessEnd;
      else if (fits(start, start + 1)) end = narrow(start + 1, guessEnd, (i) => i, start);
      else end = start + 1;
    }

    const lineText = collapsed.slice(start, drawnEnd(end));
    lines.push(
      Object.freeze({ text: lineText, width: widthOf(lineText), y: lines.length * lineHeight }),
    );
    start = end;
  }

  return Object.freeze({
    lines: Object.freeze(lines),
    width: lines.reduce((widest, line) => Math.max(widest, line.width), 0),
    height: lines.length * lineHeight,
  });
}

/** A Yoga measure function (`node.setMeasureFunc`) for the text. */
export function measureText(
  text: string,
  style: TextStyle,
  metrics: FontMetrics,
  cache: TextCache = createTextCache(),
): (width: number, widthMode: number) => { width: number; height: number } {
  assertTextSize(text);
  return (width, widthMode) => {
    const maxWidth = widthMode === MEASURE_MODE_UNDEFINED ? Infinity : width;
    const { width: blockWidth, height } = layoutText(
      text,
      style,
      maxWidth,
      metrics,
      undefined,
      cache,
    );
    return { width: blockWidth, height };
  };
}
