// Feedback payloads for POST /api/v1/feedback.
//
// Ported from the VS Code plugin (`makespdf-vscode-plugin/src/feedback.ts`)
// so both clients obey the same rules. Kept free of the `vscode-languageserver`
// import so the payload rules can be unit-tested with `node --test`. The one
// rule that matters: nothing here ever receives the Markdown text or the file
// name, so nothing here can send them. The `context` object is a fixed set of
// fingerprint fields that mirrors the server's strict schema — an unknown key,
// a non-integer, or an out-of-range value there is a 400, which would lose the
// user's message.

import { CLIENT_NAME } from "./commands.ts";

export type FeedbackKind = "problem" | "idea" | "praise";

/** Server-side cap on `message` (trimmed). */
export const FEEDBACK_MESSAGE_MAX = 4000;

/** Fingerprint-only facts about a failed export. */
export interface RenderFailureFacts {
  /** HTTP status of the failed render call; absent when it never got a response. */
  httpStatus?: number;
  /** Machine-readable `error` from the response body, when it looks like a code. */
  errorCode?: string;
  pageSize: string;
  fontFamily: string;
  fontSize: number;
  /** `Buffer.byteLength(markdown)` — a size, never the text. */
  inputBytes: number;
}

/** Exactly the keys the server accepts in `context`. */
export interface FeedbackContext {
  errorCode?: string;
  httpStatus?: number;
  inputBytes?: number;
  pageSize?: string;
  fontFamily?: string;
  fontSize?: number;
}

// Server limits (apps/web/src/routes/api/v1/feedback.tsx in makesPDF).
const ERROR_CODE_MAX = 64;
const PAGE_SIZE_MAX = 32;
const FONT_FAMILY_MAX = 64;
const INPUT_BYTES_MAX = 50_000_000;

// A code, not a sentence: `page-cap-exceeded` qualifies, "Rate limit
// exceeded" does not. Server error text can quote request values, so only a
// code-shaped token is forwarded.
const ERROR_CODE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `value` when it is a code-shaped token, else undefined. */
export function asErrorCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length > ERROR_CODE_MAX || !ERROR_CODE_SHAPE.test(value)) return undefined;
  return value;
}

function intInRange(
  value: number | undefined,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || !Number.isInteger(value) || value < min || value > max) {
    return undefined;
  }
  return value;
}

function shortString(value: string, max: number): string | undefined {
  return value && value.length <= max ? value : undefined;
}

/**
 * The `context` for a "Report problem" submission. Each field is dropped
 * rather than clamped when it falls outside the server's schema, so a
 * surprising setting (e.g. a fractional font size) costs one field, not the
 * whole report.
 */
export function buildProblemContext(facts: RenderFailureFacts): FeedbackContext {
  const context: FeedbackContext = {
    errorCode: asErrorCode(facts.errorCode),
    httpStatus: intInRange(facts.httpStatus, 0, 599),
    inputBytes: intInRange(facts.inputBytes, 0, INPUT_BYTES_MAX),
    pageSize: shortString(facts.pageSize, PAGE_SIZE_MAX),
    fontFamily: shortString(facts.fontFamily, FONT_FAMILY_MAX),
    fontSize: intInRange(facts.fontSize, 1, 200),
  };
  for (const key of Object.keys(context) as (keyof FeedbackContext)[]) {
    if (context[key] === undefined) delete context[key];
  }
  return context;
}

/**
 * The message for a "Report problem" submission from the Zed extension.
 *
 * There is no input box in the LSP UI, so unlike VS Code the user cannot type
 * a description. The message is built from the failure's shape only — never
 * the server's error text, which a 500 body can fill with document content.
 * The full error is still shown to the user locally.
 */
export function problemReportMessage(facts: RenderFailureFacts): string {
  const status = facts.httpStatus === undefined ? "no response" : `HTTP ${facts.httpStatus}`;
  return `Export failed in the Zed extension (${status}).`;
}

/** Input-box validation: an error string, or null when the message is sendable. */
export function validateFeedbackMessage(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "Please enter a message.";
  if (trimmed.length > FEEDBACK_MESSAGE_MAX) {
    return `Please keep it under ${FEEDBACK_MESSAGE_MAX} characters (currently ${trimmed.length}).`;
  }
  return null;
}

export interface FeedbackRequestArgs {
  serviceUrl: string;
  /** Server version, for the `X-MakesPDF-Client` header. */
  version: string;
  /** Empty when no key is configured: the request then goes anonymously. */
  apiToken: string;
  kind: FeedbackKind;
  message: string;
  /** Omitted from the body entirely when undefined. */
  context?: FeedbackContext;
}

export function buildFeedbackRequest(args: FeedbackRequestArgs): {
  url: string;
  init: RequestInit;
} {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-MakesPDF-Client": `${CLIENT_NAME}/${args.version}`,
  };
  // Same rule as the render call: an empty `Bearer ` is a failed auth
  // attempt (401), not an anonymous request.
  if (args.apiToken) headers.Authorization = `Bearer ${args.apiToken}`;

  const body: { kind: FeedbackKind; message: string; context?: FeedbackContext } = {
    kind: args.kind,
    message: args.message.trim(),
  };
  if (args.context) body.context = args.context;

  return {
    url: `${args.serviceUrl.replace(/\/+$/, "")}/api/v1/feedback`,
    init: { method: "POST", headers, body: JSON.stringify(body) },
  };
}

export type FeedbackResult =
  | { status: "sent" }
  | { status: "rate-limited" }
  | { status: "failed"; error: string };

/**
 * POST the feedback and classify the outcome for the UI. Never throws.
 *
 * A configured key that the server rejects (401) is retried once without
 * `Authorization`: the endpoint accepts anonymous feedback, and a stale key
 * is exactly the failure "Report problem" is offered for — without the
 * retry, the report of a bad key would itself fail on the bad key.
 */
export async function sendFeedback(
  args: FeedbackRequestArgs,
  fetchImpl: typeof fetch = fetch,
): Promise<FeedbackResult> {
  let response: Response;
  try {
    response = await post(args, fetchImpl);
    if (response.status === 401 && args.apiToken) {
      response = await post({ ...args, apiToken: "" }, fetchImpl);
    }
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
  if (response.ok) return { status: "sent" };
  if (response.status === 429) return { status: "rate-limited" };

  let detail = `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body?.error === "string" && body.error) detail = `${body.error} (${detail})`;
  } catch {
    /* non-JSON error body — the status is all we have */
  }
  return { status: "failed", error: detail };
}

function post(args: FeedbackRequestArgs, fetchImpl: typeof fetch): Promise<Response> {
  const { url, init } = buildFeedbackRequest(args);
  return fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
}
