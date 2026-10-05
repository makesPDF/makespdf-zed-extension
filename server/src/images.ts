// Inline local image references as `data:` URIs before an export.
//
// The makesPDF service fetches only `http(s)` and `data:` URLs — it has no
// access to the user's filesystem — so an image referenced by a local path
// (`![diagram](diagram.png)`) would be silently dropped from the PDF. This
// mirrors the VS Code plugin's `inlineLocalImages`: remote and `data:` URLs
// are left alone, code blocks and inline spans are masked so literal
// image-like text is untouched, and unreadable or oversized files are
// returned as failures. The caller stops the export on any failure: a PDF
// that silently lacks an image is worse than no PDF.
//
// References are found with left-to-right scans rather than the VS Code
// plugin's backtracking regexes: the document is arbitrary input, and runs of
// unterminated references (`![a](` repeated) made those regexes quadratic —
// ~13s of blocking work at 160KB, hours at a few MB — in a single-threaded
// language server. The scans memoise the delimiter lookups they would
// otherwise repeat, so they stay linear while still finding every reference
// the regexes found, including references nested inside malformed ones.

import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";

/**
 * The service's per-image cap (MAX_IMAGE_SIZE in its image-utils). A file
 * above it would be skipped server-side, so its bytes are never uploaded.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** MIME types for image extensions, matching the VS Code plugin. */
export const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".apng": "image/apng",
};

export type ImageFailureReason = "unreadable" | "too-large";

export interface ImageFailure {
  /** The reference as written, minus `<…>` brackets and surrounding space. */
  src: string;
  reason: ImageFailureReason;
}

export interface InlineResult {
  markdown: string;
  /** References left as-is, in document order; empty when all were inlined. */
  failures: ImageFailure[];
}

/**
 * Replace local image references in `source` with base64 `data:` URIs read
 * from disk, resolving relative paths against `baseDir`. Remote URLs (http,
 * https, data, file, protocol-relative), unknown extensions, and references
 * inside code blocks/spans are left untouched. Unreadable files and files
 * over MAX_IMAGE_BYTES are left as references and reported in `failures`.
 */
export async function inlineLocalImages(
  source: string,
  baseDir: string,
): Promise<InlineResult> {
  // Protect code so we never rewrite image-like text inside fenced blocks or
  // inline spans (where it's literal text the user wants to see verbatim).
  const { masked, restore } = maskCode(source);

  // The two syntaxes are scanned independently, as the regexes were, so a
  // reference nested inside another reference's text is still found.
  const markdownMatches = scanMarkdownImages(masked);
  const htmlMatches = scanHtmlImages(masked);

  const srcs = new Set<string>();
  for (const match of [...markdownMatches, ...htmlMatches].sort((a, b) => a.start - b.start)) {
    srcs.add(cleanSrc(match.src));
  }

  const candidates = [...srcs].filter(
    (src) => isInlinableLocalSrc(src) && IMAGE_MIME_BY_EXT[extname(src).toLowerCase()],
  );

  interface Resolved {
    src: string;
    dataUri?: string;
    reason?: ImageFailureReason;
  }
  const resolved = await Promise.all(
    candidates.map(async (src): Promise<Resolved> => {
      const mime = IMAGE_MIME_BY_EXT[extname(src).toLowerCase()]!;
      const path = toFsPath(src, baseDir);
      try {
        // `stat` first so an oversized file's bytes are never read; the
        // length check after reading covers a file that grew in between.
        if ((await stat(path)).size > MAX_IMAGE_BYTES) {
          return { src, reason: "too-large" };
        }
        const bytes = await readFile(path);
        if (bytes.length > MAX_IMAGE_BYTES) {
          return { src, reason: "too-large" };
        }
        return { src, dataUri: `data:${mime};base64,${bytes.toString("base64")}` };
      } catch {
        return { src, reason: "unreadable" };
      }
    }),
  );

  const dataUris = new Map<string, string>();
  const failures: ImageFailure[] = [];
  for (const entry of resolved) {
    if (entry.dataUri !== undefined) dataUris.set(entry.src, entry.dataUri);
    else if (entry.reason !== undefined) {
      failures.push({ src: entry.src, reason: entry.reason });
    }
  }

  if (dataUris.size === 0) return { markdown: source, failures };

  // Markdown replacements first, then a fresh HTML scan of the result —
  // exactly the two `String.replace` passes this replaces.
  let out = replaceMatches(masked, markdownMatches, dataUris);
  out = replaceMatches(out, scanHtmlImages(out), dataUris);
  return { markdown: restore(out), failures };
}

/** A well-formed image reference found in the masked document. */
interface ImageMatch {
  /** Index of the opening `![` or `<img`. */
  start: number;
  /** Index one past the reference's final character. */
  end: number;
  /** The src token as captured, before `cleanSrc`. */
  src: string;
  /** `![alt](…)` only: the alt text and the raw title suffix (may be ""). */
  markdown?: { alt: string; title: string };
  /** `<img …>` only: index of the value's opening quote and the quote char. */
  html?: { quoteStart: number; quote: string };
}

/** `![alt](src "title")` matches, in document order and in linear time. */
function scanMarkdownImages(s: string): ImageMatch[] {
  const matches: ImageMatch[] = [];
  const runs = new RunMemo();
  const quotes = new QuoteMemo();
  const gts = new GtMemo();
  let cursor = 0;
  for (;;) {
    const start = s.indexOf("![", cursor);
    if (start === -1) break;
    const altEnd = s.indexOf("]", start + 2);
    if (altEnd === -1) break;
    if (s[altEnd + 1] !== "(") {
      // Every `![` between `start` and this `]` closes its alt here too and
      // fails identically; resume past the `]` instead of retrying each one.
      cursor = altEnd + 1;
      continue;
    }
    let k = altEnd + 2;
    while (k < s.length && isSpace(s[k]!)) k++;

    const match = matchMarkdownSrc(s, start, altEnd, k, runs, quotes, gts);
    if (match) {
      matches.push(match);
      cursor = match.end;
    } else {
      // Resume past the alt close: later `![` starts after it get their own
      // alt close and are parsed normally.
      cursor = altEnd + 1;
    }
  }
  return matches;
}

/** Parse the `src "title")` tail of a markdown image opening at `start`. */
function matchMarkdownSrc(
  s: string,
  start: number,
  altEnd: number,
  k: number,
  runs: RunMemo,
  quotes: QuoteMemo,
  gts: GtMemo,
): ImageMatch | null {
  const alt = s.slice(start + 2, altEnd);

  if (s[k] === "<") {
    const gt = gts.firstAtOrAfter(s, k + 1);
    if (gt > k + 1) {
      const title = coverTitle(s, gt + 1, quotes);
      if (title !== null) {
        return {
          start,
          end: title.end,
          src: s.slice(k, gt + 1),
          markdown: { alt, title: title.text },
        };
      }
    }
  }

  const t = runs.endOfRun(s, k);
  if (t > k) {
    const title = coverTitle(s, t, quotes);
    if (title !== null) {
      return {
        start,
        end: title.end,
        src: s.slice(k, t),
        markdown: { alt, title: title.text },
      };
    }
  }
  return null;
}

/**
 * Parse the part after a src: optional whitespace, then either `)` or a
 * quoted title followed by optional whitespace and `)`. Returns the match
 * end (one past `)`) and the title suffix as the regex replacement kept it.
 */
function coverTitle(
  s: string,
  pos: number,
  quotes: QuoteMemo,
): { end: number; text: string } | null {
  let q = pos;
  while (q < s.length && isSpace(s[q]!)) q++;
  if (s[q] === ")") return { end: q + 1, text: "" };
  if (q === pos) return null;
  const quote = s[q];
  if (quote !== '"' && quote !== "'") return null;
  const close = quotes.firstAtOrAfter(s, quote, q + 1);
  if (close === -1) return null;
  let r = close + 1;
  while (r < s.length && isSpace(s[r]!)) r++;
  if (s[r] !== ")") return null;
  return { end: r + 1, text: s.slice(pos, close + 1) };
}

/** `<img … src="…">` matches, in document order and in linear time. */
function scanHtmlImages(s: string): ImageMatch[] {
  const matches: ImageMatch[] = [];
  const gts = new GtMemo();
  let cursor = 0;
  for (;;) {
    const start = indexOfCI(s, "<img", cursor);
    if (start === -1) break;
    const after = start + 4;
    // `\b` after `<img`: `<imgsrc=…` is not a tag.
    if (after < s.length && isWordChar(s[after]!)) {
      cursor = start + 1;
      continue;
    }
    const gt = gts.firstAtOrAfter(s, after);
    const limit = gt === -1 ? s.length : gt;

    let match: ImageMatch | null = null;
    for (
      let q = indexOfCI(s, "src", after, limit);
      q !== -1;
      q = indexOfCI(s, "src", q + 1, limit)
    ) {
      // A single `\b` would also match `data-src=`, whose value the renderer
      // never uses; embedding it would leave the real src local and the
      // image dropped. A real attribute name starts after whitespace.
      if (q === 0 || !isSpace(s[q - 1]!)) continue;
      let r = q + 3;
      while (r < s.length && isSpace(s[r]!)) r++;
      if (s[r] !== "=") continue;
      r++;
      while (r < s.length && isSpace(s[r]!)) r++;
      const quote = s[r];
      if (quote !== '"' && quote !== "'") continue;
      const close = s.indexOf(quote, r + 1);
      if (close === -1) continue;
      match = {
        start,
        end: close + 1,
        src: s.slice(r + 1, close),
        html: { quoteStart: r, quote },
      };
      break;
    }

    if (match) {
      matches.push(match);
      cursor = match.end;
    } else {
      // Every `src` before the tag's `>` was rejected, and a later `<img`
      // sees a subset of that same text, so resume past the tag (or stop
      // when it has no `>`: no later tag can close either).
      cursor = gt === -1 ? s.length : gt + 1;
    }
  }
  return matches;
}

/** Replace every matched reference whose src resolved, preserving the rest. */
function replaceMatches(
  source: string,
  matches: ImageMatch[],
  dataUris: Map<string, string>,
): string {
  let out = "";
  let cursor = 0;
  let changed = false;
  for (const match of matches) {
    const uri = dataUris.get(cleanSrc(match.src));
    if (uri === undefined) continue;
    out += source.slice(cursor, match.start);
    if (match.markdown) {
      out += `![${match.markdown.alt}](${uri}${match.markdown.title})`;
    } else {
      const { quoteStart, quote } = match.html!;
      out += `${source.slice(match.start, quoteStart)}${quote}${uri}${quote}`;
    }
    cursor = match.end;
    changed = true;
  }
  return changed ? out + source.slice(cursor) : source;
}

/**
 * The end of a plain src run (the first `)` or whitespace at/after `k`),
 * memoised so a run of failing attempts that start inside the same run is
 * not rescanned. Queried with non-decreasing `k`.
 */
class RunMemo {
  private k = -1;
  private t = -1;

  endOfRun(s: string, k: number): number {
    if (this.k !== -1 && k >= this.k && k <= this.t) return this.t;
    let t = k;
    while (t < s.length && s[t] !== ")" && !isSpace(s[t]!)) t++;
    this.k = k;
    this.t = t;
    return t;
  }
}

/** The first `>` at or after a position, memoised across failed candidates. */
class GtMemo {
  private from = -1;
  private gt = -1;

  firstAtOrAfter(s: string, from: number): number {
    if (this.from !== -1 && from >= this.from && (this.gt === -1 || from <= this.gt)) {
      return this.gt;
    }
    this.from = from;
    this.gt = s.indexOf(">", from);
    return this.gt;
  }
}

/** The first quote character at or after a position, memoised per quote. */
class QuoteMemo {
  private readonly quotes = new Map<string, { from: number; index: number }>();

  firstAtOrAfter(s: string, quote: string, from: number): number {
    const memo = this.quotes.get(quote);
    if (memo && from >= memo.from && (memo.index === -1 || from <= memo.index)) {
      return memo.index;
    }
    const index = s.indexOf(quote, from);
    this.quotes.set(quote, { from, index });
    return index;
  }
}

const SPACE = /\s/;
const WORD = /[A-Za-z0-9_]/;

function isSpace(c: string): boolean {
  return SPACE.test(c);
}

function isWordChar(c: string): boolean {
  return WORD.test(c);
}

/** Case-insensitive `indexOf`, searching starts in `[from, to - needle.length]`. */
function indexOfCI(s: string, needle: string, from: number, to = s.length): number {
  const lower = needle.toLowerCase();
  const last = Math.min(to, s.length) - lower.length;
  for (let i = Math.max(0, from); i <= last; i++) {
    let hit = true;
    for (let j = 0; j < lower.length; j++) {
      if (s[i + j]!.toLowerCase() !== lower[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return i;
  }
  return -1;
}

const FAILURE_REASON_TEXT: Record<ImageFailureReason, string> = {
  unreadable: "could not be read",
  "too-large": "too large to embed, max 5MB",
};

/** At most this many failed references are named; the rest are counted. */
const MAX_NAMED_FAILURES = 10;

/**
 * The error that stops an export when a local image could not be embedded,
 * or `null` when nothing failed. Names each failed reference (up to
 * MAX_NAMED_FAILURES) with its reason, so the user can fix or remove it.
 */
export function formatImageFailure(failures: ImageFailure[]): string | null {
  if (failures.length === 0) return null;
  const names = failures
    .slice(0, MAX_NAMED_FAILURES)
    .map((failure) => `${failure.src} (${FAILURE_REASON_TEXT[failure.reason]})`);
  const more = failures.length - names.length;
  const listed = more > 0 ? `${names.join(", ")} and ${more} more` : names.join(", ");
  const one = failures.length === 1;
  return (
    `Export stopped, no PDF was written: ${failures.length} local ` +
    `image${one ? "" : "s"} could not be embedded: ${listed}. ` +
    `Fix or remove ${one ? "the reference" : "these references"} and export again.`
  );
}

/** Strip surrounding <…> angle brackets and whitespace from a src token. */
function cleanSrc(raw: string): string {
  const s = raw.trim();
  return s.startsWith("<") && s.endsWith(">") ? s.slice(1, -1).trim() : s;
}

/**
 * Whether a src is a local path we should inline. Skips anything with a URL
 * scheme of two or more characters (http:, https:, data:, file:) so that
 * Windows drive paths like `C:\img.png` are still treated as local, plus
 * protocol-relative (`//host/x`) and fragment-only refs.
 */
function isInlinableLocalSrc(src: string): boolean {
  if (!src) return false;
  if (/^[a-z][a-z0-9+.-]+:/i.test(src)) return false;
  if (src.startsWith("//") || src.startsWith("#")) return false;
  return true;
}

/** Resolve a (possibly percent-encoded) src to an absolute filesystem path. */
function toFsPath(src: string, baseDir: string): string {
  let p = src;
  try {
    p = decodeURIComponent(src);
  } catch {
    /* malformed escapes — fall back to the raw string */
  }
  return isAbsolute(p) ? p : resolve(baseDir, p);
}

/**
 * Replace fenced code blocks and inline code spans with NUL-delimited
 * sentinel tokens so the image scan never touches them, returning a
 * `restore` to swap them back in. NUL cannot occur in document text.
 */
function maskCode(input: string): {
  masked: string;
  restore: (s: string) => string;
} {
  const stash: string[] = [];
  const keep = (m: string) => {
    const token = `\u0000CODE${stash.length}\u0000`;
    stash.push(m);
    return token;
  };
  const masked = input
    .replace(/```[\s\S]*?```/g, keep)
    .replace(/~~~[\s\S]*?~~~/g, keep)
    .replace(/``[^`]*``/g, keep)
    .replace(/`[^`\n]*`/g, keep);
  const restore = (s: string) =>
    s.replace(/\u0000CODE(\d+)\u0000/g, (_t, i: string) => stash[Number(i)]!);
  return { masked, restore };
}
