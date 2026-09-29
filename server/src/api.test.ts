import { test } from "node:test";
import assert from "node:assert/strict";
import {
  apiUrl,
  classifyApiFailure,
  connectionFailureMessage,
  formatValidateSummary,
  markdownBody,
  savedMessage,
} from "./api.ts";

test("apiUrl joins without doubling slashes", () => {
  assert.equal(apiUrl("https://makespdf.com", "/api/v1/md"), "https://makespdf.com/api/v1/md");
  assert.equal(
    apiUrl("https://makespdf.com///", "/api/v1/md"),
    "https://makespdf.com/api/v1/md",
  );
});

test("the request body carries the buffer and the options", () => {
  const body = JSON.parse(
    markdownBody("# Hi", {
      pageSize: "A4",
      fontFamily: "Inter",
      fontSize: 10,
      margins: [40, 40, 40, 40],
      title: "note",
    }),
  );
  assert.deepEqual(body, {
    markdown: "# Hi",
    options: {
      pageSize: "A4",
      fontFamily: "Inter",
      fontSize: 10,
      margins: [40, 40, 40, 40],
      title: "note",
    },
  });
});

test("a 401 with a key blames the key and points at the API keys page", () => {
  const failure = classifyApiFailure({
    operation: "export",
    status: 401,
    apiToken: "stale",
    serviceUrl: "https://makespdf.com",
    body: { error: "Unauthorized" },
  });
  assert.equal(failure.kind, "auth");
  assert.equal(failure.errorCode, "Unauthorized");
  assert.match(failure.message, /API token rejected/);
  assert.match(failure.message, /https:\/\/makespdf\.com\/settings\/api-keys/);
});

test("a 401 without a key explains that the server wants an account", () => {
  const failure = classifyApiFailure({
    operation: "export",
    status: 401,
    apiToken: "",
    serviceUrl: "https://makespdf.com",
    body: {},
  });
  assert.equal(failure.kind, "auth");
  assert.match(failure.message, /requires an API token/);
});

test("a 429 suggests signing up only when anonymous", () => {
  const anon = classifyApiFailure({
    operation: "export",
    status: 429,
    apiToken: "",
    serviceUrl: "https://makespdf.com",
    body: {},
  });
  assert.equal(anon.kind, "rate-limit");
  assert.match(anon.message, /sign up/);

  const authed = classifyApiFailure({
    operation: "export",
    status: 429,
    apiToken: "k",
    serviceUrl: "https://makespdf.com",
    body: {},
  });
  assert.equal(authed.kind, "rate-limit");
  assert.doesNotMatch(authed.message, /sign up/);
});

test("the anonymous page cap is reported with the actual and limit", () => {
  const failure = classifyApiFailure({
    operation: "export",
    status: 400,
    apiToken: "",
    serviceUrl: "https://makespdf.com",
    body: { error: "page-cap-exceeded", actual: 27, limit: 20, tip: "Get an API key." },
  });
  assert.equal(failure.kind, "page-cap");
  assert.match(failure.message, /27 pages, cap 20/);
  assert.match(failure.message, /Get an API key\./);
  assert.equal(failure.errorCode, "page-cap-exceeded");
});

test("any other status shows the server's error field", () => {
  const failure = classifyApiFailure({
    operation: "export",
    status: 500,
    apiToken: "",
    serviceUrl: "https://makespdf.com",
    body: { error: "render pipeline exploded" },
  });
  assert.equal(failure.kind, "error");
  assert.match(failure.message, /HTTP 500/);
  assert.match(failure.message, /render pipeline exploded/);
  // Sentences are not code-shaped: they must not become feedback context.
  assert.equal(failure.errorCode, undefined);
});

test("a failed validate is not reported as a failed export", () => {
  const failure = classifyApiFailure({
    operation: "validate",
    status: 500,
    apiToken: "k",
    serviceUrl: "https://makespdf.com",
    body: {},
  });
  assert.match(failure.message, /validate failed \(HTTP 500\)/);
  assert.doesNotMatch(failure.message, /export/);
});

test("a non-JSON error body still yields a status message", () => {
  const failure = classifyApiFailure({
    operation: "export",
    status: 502,
    apiToken: "",
    serviceUrl: "https://makespdf.com",
    body: {},
  });
  assert.equal(failure.kind, "error");
  assert.match(failure.message, /HTTP 502/);
});

test("transport failures name the service and nothing else", () => {
  assert.equal(
    connectionFailureMessage("export", "http://127.0.0.1:1", new Error("fetch failed")),
    "makesPDF: could not reach the PDF service at http://127.0.0.1:1.",
  );
  assert.match(
    connectionFailureMessage("export", "https://makespdf.com", new Error("socket hang up")),
    /export failed: socket hang up/,
  );
  assert.match(
    connectionFailureMessage("validate", "https://makespdf.com", new Error("socket hang up")),
    /validate failed: socket hang up/,
  );
});

test("validate summaries count, show the first three issues and the rest", () => {
  assert.equal(
    formatValidateSummary({ valid: true, issues: [], summary: { errors: 0, warnings: 0 } }),
    "No accessibility issues found.",
  );

  const result = {
    valid: false,
    issues: [
      { severity: "error", message: "Heading level skipped" },
      { severity: "warning", message: "Image missing alt text" },
      { severity: "warning", message: "Another warning" },
      { severity: "warning", message: "Fourth issue" },
    ],
    summary: { errors: 1, warnings: 3 },
  };
  const summary = formatValidateSummary(result);
  assert.match(summary, /^1 error, 3 warnings\./);
  assert.match(summary, /Heading level skipped/);
  assert.match(summary, /Image missing alt text/);
  assert.match(summary, /Another warning/);
  assert.doesNotMatch(summary, /Fourth issue/);
  assert.match(summary, /\(\+1 more\)/);
});

test("validate summaries fall back to counting severities", () => {
  const summary = formatValidateSummary({
    issues: [
      { severity: "error", message: "one" },
      { severity: "error", message: "two" },
    ],
  });
  assert.match(summary, /^2 errors, 0 warnings\./);
});

test("the saved message carries the path and optional stats", () => {
  assert.equal(savedMessage("/tmp/a/note.pdf", null, null), "makesPDF: PDF saved to /tmp/a/note.pdf");
  assert.equal(
    savedMessage("/tmp/a/note.pdf", "1", "123"),
    "makesPDF: PDF saved to /tmp/a/note.pdf (1 page, 123ms)",
  );
  assert.equal(
    savedMessage("/tmp/a/note.pdf", "3", null),
    "makesPDF: PDF saved to /tmp/a/note.pdf (3 pages)",
  );
});
