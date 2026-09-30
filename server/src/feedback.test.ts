import { test } from "node:test";
import assert from "node:assert/strict";
import {
  asErrorCode,
  buildFeedbackRequest,
  buildProblemContext,
  problemReportMessage,
  sendFeedback,
  validateFeedbackMessage,
} from "./feedback.ts";

const FACTS = {
  httpStatus: 400,
  errorCode: "page-cap-exceeded",
  pageSize: "A4",
  fontFamily: "Inter",
  fontSize: 10,
  inputBytes: 1234,
};

test("problem context carries exactly the fingerprint fields", () => {
  assert.deepEqual(buildProblemContext(FACTS), FACTS);
});

test("problem context drops fields the server schema would reject", () => {
  const context = buildProblemContext({
    ...FACTS,
    httpStatus: undefined,
    errorCode: "Rate limit exceeded",
    fontSize: 10.5,
    inputBytes: 60_000_000,
  });
  assert.deepEqual(context, { pageSize: "A4", fontFamily: "Inter" });
});

test("only code-shaped error strings are forwarded", () => {
  assert.equal(asErrorCode("page-cap-exceeded"), "page-cap-exceeded");
  assert.equal(asErrorCode('Unknown tag "secret"'), undefined);
  assert.equal(asErrorCode("x".repeat(65)), undefined);
  assert.equal(asErrorCode(42), undefined);
});

test("the report message is built from the failure shape, never server text", () => {
  const message = problemReportMessage({
    ...FACTS,
    errorCode: undefined,
  });
  assert.equal(message, "Export failed in the Zed extension (HTTP 400).");
  assert.equal(
    problemReportMessage({ ...FACTS, httpStatus: undefined }),
    "Export failed in the Zed extension (no response).",
  );
});

test("the request body holds kind, message and context and nothing else", () => {
  const markdown = "# Quarterly numbers\n\nConfidential revenue 1234";
  const fileName = "board-report.md";
  const { url, init } = buildFeedbackRequest({
    serviceUrl: "https://makespdf.com/",
    version: "0.1.0",
    apiToken: "",
    kind: "problem",
    message: "  The export failed on a long table.  ",
    context: buildProblemContext({ ...FACTS, inputBytes: Buffer.byteLength(markdown) }),
  });

  assert.equal(url, "https://makespdf.com/api/v1/feedback");
  const body = JSON.parse(init.body as string);
  assert.deepEqual(Object.keys(body).sort(), ["context", "kind", "message"]);
  assert.equal(body.message, "The export failed on a long table.");
  assert.deepEqual(Object.keys(body.context).sort(), [
    "errorCode",
    "fontFamily",
    "fontSize",
    "httpStatus",
    "inputBytes",
    "pageSize",
  ]);
  const raw = init.body as string;
  assert.ok(!raw.includes("Quarterly"), "markdown text must not be sent");
  assert.ok(
    !raw.includes(fileName) && !raw.includes("board-report"),
    "file name must not be sent",
  );
});

test("headers: client header always, Authorization only with a token", () => {
  const anon = buildFeedbackRequest({
    serviceUrl: "https://makespdf.com",
    version: "0.1.0",
    apiToken: "",
    kind: "idea",
    message: "More themes please",
  });
  const anonHeaders = anon.init.headers as Record<string, string>;
  assert.equal(anonHeaders["X-MakesPDF-Client"], "zed/0.1.0");
  assert.equal(anonHeaders.Authorization, undefined);
  assert.ok(!("context" in JSON.parse(anon.init.body as string)), "command sends no context");

  const authed = buildFeedbackRequest({
    serviceUrl: "https://makespdf.com",
    version: "0.1.0",
    apiToken: "key_123",
    kind: "praise",
    message: "Great",
  });
  assert.equal(
    (authed.init.headers as Record<string, string>).Authorization,
    "Bearer key_123",
  );
});

test("message validation mirrors the server's 1..4000 trimmed range", () => {
  assert.equal(validateFeedbackMessage("   "), "Please enter a message.");
  assert.equal(validateFeedbackMessage("ok"), null);
  assert.equal(validateFeedbackMessage("x".repeat(4000)), null);
  assert.match(validateFeedbackMessage("x".repeat(4001)) ?? "", /under 4000/);
});

const ARGS = {
  serviceUrl: "https://makespdf.com",
  version: "0.1.0",
  apiToken: "",
  kind: "idea" as const,
  message: "hello there",
};

function fakeFetch(response: Response | Error): typeof fetch {
  return (async () => {
    if (response instanceof Error) throw response;
    return response;
  }) as typeof fetch;
}

test("sendFeedback classifies success, 429 and other failures", async () => {
  assert.deepEqual(
    await sendFeedback(
      ARGS,
      fakeFetch(new Response('{"feedbackId":"f1"}', { status: 200 })),
    ),
    { status: "sent" },
  );
  assert.deepEqual(
    await sendFeedback(ARGS, fakeFetch(new Response("{}", { status: 429 }))),
    { status: "rate-limited" },
  );
  assert.deepEqual(
    await sendFeedback(
      ARGS,
      fakeFetch(new Response('{"error":"Invalid request"}', { status: 400 })),
    ),
    { status: "failed", error: "Invalid request (HTTP 400)" },
  );
  assert.deepEqual(
    await sendFeedback(ARGS, fakeFetch(new Response("<html>", { status: 502 }))),
    { status: "failed", error: "HTTP 502" },
  );
  assert.deepEqual(await sendFeedback(ARGS, fakeFetch(new Error("fetch failed"))), {
    status: "failed",
    error: "fetch failed",
  });
});

test("a rejected key is retried once anonymously, so a stale key can still report", async () => {
  const seen: (string | undefined)[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const auth = (init.headers as Record<string, string>).Authorization;
    seen.push(auth);
    return new Response("{}", { status: auth ? 401 : 200 });
  }) as unknown as typeof fetch;

  assert.deepEqual(await sendFeedback({ ...ARGS, apiToken: "stale" }, fetchImpl), {
    status: "sent",
  });
  assert.deepEqual(seen, ["Bearer stale", undefined]);

  // No key configured: a 401 is not retried (there is nothing to drop).
  const anon401 = fakeFetch(new Response('{"error":"Unauthorized"}', { status: 401 }));
  assert.deepEqual(await sendFeedback(ARGS, anon401), {
    status: "failed",
    error: "Unauthorized (HTTP 401)",
  });
});
