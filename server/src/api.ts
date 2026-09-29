// Request builders and response classifiers for the makesPDF HTTP API.
//
// Pure functions (no LSP, no fs) so the rules can be unit-tested with
// `node --test`; server.ts wires them to fetch and the editor UI.

import { CLIENT_NAME } from "./commands.ts";
import type { MakesPdfSettings } from "./settings.ts";

export const RENDER_PATH = "/api/v1/md";
export const VALIDATE_PATH = "/api/v1/md/validate";

/** `serviceUrl` with any trailing slashes removed, then the API path. */
export function apiUrl(serviceUrl: string, path: string): string {
  return `${serviceUrl.replace(/\/+$/, "")}${path}`;
}

/**
 * Headers for every makesPDF API call. The client header is always sent; an
 * empty `Bearer ` would be a failed auth attempt (401) rather than the
 * anonymous path, so Authorization is omitted without a key.
 */
export function requestHeaders(version: string, apiToken: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-MakesPDF-Client": `${CLIENT_NAME}/${version}`,
  };
  if (apiToken) headers.Authorization = `Bearer ${apiToken}`;
  return headers;
}

export interface RenderOptions {
  pageSize: string;
  fontFamily: string;
  fontSize: number;
  margins: number[];
  /** Document title (the file's base name), passed through to the renderer. */
  title: string;
}

/** Body for POST /api/v1/md and POST /api/v1/md/validate. */
export function markdownBody(markdown: string, options: RenderOptions): string {
  return JSON.stringify({ markdown, options });
}

/** The shape of the server's JSON error bodies. */
export interface ErrorDetail {
  error?: string;
  tip?: string;
  limit?: number;
  actual?: number;
}

/** Parse a JSON error body; a non-JSON or non-object body yields `{}`. */
export function readErrorDetail(body: unknown): ErrorDetail {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as ErrorDetail;
  }
  return {};
}

export type ApiFailureKind = "auth" | "rate-limit" | "page-cap" | "error";

export interface ApiFailure {
  kind: ApiFailureKind;
  /** The message to show the user. */
  message: string;
  /** The server's `error` value when it is code-shaped, for feedback context. */
  errorCode?: string;
}

/**
 * Turn a non-2xx render/validate response into a message and a failure kind.
 * Mirrors the VS Code plugin's handling, including the sign-up hint for an
 * anonymous rate limit and the structured page-cap guidance.
 */
export function classifyApiFailure(args: {
  status: number;
  apiToken: string;
  serviceUrl: string;
  body: unknown;
}): ApiFailure {
  const { status, apiToken, serviceUrl, body } = args;
  const detail = readErrorDetail(body);
  const base = serviceUrl.replace(/\/+$/, "");

  if (status === 401 || status === 403) {
    if (apiToken) {
      return {
        kind: "auth",
        message:
          "makesPDF: API token rejected. Check `lsp.makespdf.settings.apiToken` " +
          `or create a key at ${base}/settings/api-keys.`,
        errorCode: codeShaped(detail.error),
      };
    }
    return {
      kind: "auth",
      message:
        "makesPDF: this server requires an API token. Create one at " +
        `${base}/settings/api-keys and paste it into \`lsp.makespdf.settings.apiToken\`.`,
      errorCode: codeShaped(detail.error),
    };
  }

  if (status === 429) {
    const hint = apiToken
      ? "Wait a few minutes and try again."
      : `Wait a few minutes, or sign up at ${base}/signup for higher limits.`;
    return {
      kind: "rate-limit",
      message: `makesPDF: rate limited. ${detail.tip ?? hint}`,
      errorCode: codeShaped(detail.error),
    };
  }

  if (status === 400 && detail.error === "page-cap-exceeded") {
    const pages = detail.actual ?? "too many";
    const cap = detail.limit ?? 20;
    return {
      kind: "page-cap",
      message:
        `makesPDF: document is too long for an anonymous render (${pages} pages, cap ${cap}). ` +
        (detail.tip ?? `Sign up at ${base}/signup for higher limits.`),
      errorCode: codeShaped(detail.error),
    };
  }

  const detailText = typeof detail.error === "string" && detail.error ? detail.error : undefined;
  return {
    kind: "error",
    message: `makesPDF: export failed (HTTP ${status})${detailText ? `: ${detailText}` : "."}`,
    errorCode: codeShaped(detail.error),
  };
}

// Only a code-shaped token is forwarded to feedback; server error text can
// quote request content, and feedback `context` must stay fingerprint-only.
// (Same rule as feedback.ts's asErrorCode.)
function codeShaped(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) return undefined;
  return value;
}

export interface ValidateIssue {
  severity?: string;
  message?: string;
  path?: string;
  rule?: string;
}

export interface ValidateResult {
  valid?: boolean;
  issues?: ValidateIssue[];
  summary?: { errors?: number; warnings?: number };
}

/** The `N errors, M warnings` summary line for a successful validate call. */
export function formatValidateSummary(result: ValidateResult): string {
  const issues = Array.isArray(result.issues) ? result.issues : [];
  const errors =
    result.summary?.errors ?? issues.filter((issue) => issue.severity === "error").length;
  const warnings =
    result.summary?.warnings ?? issues.filter((issue) => issue.severity === "warning").length;

  if (errors === 0 && warnings === 0) return "No accessibility issues found.";

  const parts = [
    `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}.`,
  ];
  const shown = issues
    .slice(0, 3)
    .map((issue) => truncate(issue.message ?? "(no message)", 120));
  if (shown.length) parts.push(shown.join(" · "));
  if (issues.length > shown.length) parts.push(`(+${issues.length - shown.length} more)`);
  return parts.join(" ");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The info line shown after a successful export. */
export function savedMessage(
  pdfPath: string,
  pages: string | null,
  renderMs: string | null,
): string {
  const stats = [
    pages && `${pages} page${pages === "1" ? "" : "s"}`,
    renderMs && `${renderMs}ms`,
  ]
    .filter(Boolean)
    .join(", ");
  return `makesPDF: PDF saved to ${pdfPath}${stats ? ` (${stats})` : ""}`;
}

/** The user-facing message for a transport failure (no HTTP response). */
export function connectionFailureMessage(serviceUrl: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|timed out|aborted/i.test(message)) {
    return `makesPDF: could not reach the PDF service at ${serviceUrl}.`;
  }
  return `makesPDF: export failed: ${message}`;
}

/** Options object assembled from the merged settings, for the request body. */
export function optionsFromSettings(
  settings: MakesPdfSettings,
  title: string,
): RenderOptions {
  return {
    pageSize: settings.pageSize,
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    margins: settings.margins,
    title,
  };
}
