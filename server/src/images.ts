// Inline local image references as `data:` URIs before an export.
//
// The makesPDF service fetches only `http(s)` and `data:` URLs — it has no
// access to the user's filesystem — so an image referenced by a local path
// (`![diagram](diagram.png)`) would be silently dropped from the PDF. This
// mirrors the VS Code plugin's `inlineLocalImages`: remote and `data:` URLs
// are left alone, code blocks and inline spans are masked so literal
// image-like text is untouched, and unreadable or oversized files are
// reported non-fatally and left as references.

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

// Markdown image: ![alt](src "optional title"). Group 2 is the src (possibly
// wrapped in <…>); group 3 is the optional title with its leading whitespace.
const MD_IMAGE =
  /!\[([^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)((?:\s+(?:"[^"]*"|'[^']*'))?)\s*\)/g;
// HTML <img …src="…">. Group 1 is everything up to and including `src=`,
// group 3/4 is the quoted value (double/single).
const HTML_IMAGE_SRC = /(<img\b[^>]*?\bsrc\s*=\s*)("([^"]*)"|'([^']*)')/gi;

export type ImageFailureReason = "unreadable" | "too-large";

export interface ImageFailure {
  /** The reference exactly as written in the Markdown. */
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

  const srcs = new Set<string>();
  for (const m of masked.matchAll(MD_IMAGE)) srcs.add(cleanSrc(m[2]!));
  for (const m of masked.matchAll(HTML_IMAGE_SRC)) {
    srcs.add(cleanSrc(m[3] ?? m[4] ?? ""));
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

  let out = masked.replace(
    MD_IMAGE,
    (whole, alt: string, url: string, title?: string) => {
      const uri = dataUris.get(cleanSrc(url));
      return uri ? `![${alt}](${uri}${title ?? ""})` : whole;
    },
  );
  out = out.replace(
    HTML_IMAGE_SRC,
    (whole, prefix: string, _quoted: string, dq?: string, sq?: string) => {
      const uri = dataUris.get(cleanSrc(dq ?? sq ?? ""));
      if (!uri) return whole;
      const quote = dq !== undefined ? '"' : "'";
      return `${prefix}${quote}${uri}${quote}`;
    },
  );

  return { markdown: restore(out), failures };
}

const FAILURE_REASON_TEXT: Record<ImageFailureReason, string> = {
  unreadable: "could not be read",
  "too-large": "too large to embed, max 5MB",
};

/**
 * One non-fatal warning naming the images that were left as references, or
 * `null` when nothing failed. Mirrors the VS Code plugin's notice: at most
 * three names are listed, then an ellipsis.
 */
export function formatImageNotice(failures: ImageFailure[]): string | null {
  if (failures.length === 0) return null;
  const names = failures
    .slice(0, 3)
    .map((failure) => `${failure.src} (${FAILURE_REASON_TEXT[failure.reason]})`);
  const ellipsis = failures.length > 3 ? "…" : "";
  const plural = failures.length === 1 ? "" : "s";
  return (
    `Could not embed ${failures.length} local image${plural}: ` +
    `${names.join(", ")}${ellipsis}. They were left as-is.`
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
