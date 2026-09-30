// End-to-end LSP integration test.
//
// Spawns the built sidecar (dist/server.js, built by `npm run test:integration`)
// over stdio and drives it with a minimal LSP client against a local mock HTTP
// server: initialize -> code actions -> execute export/validate -> feedback.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { LspClient } from "./helpers/lsp-client.ts";
import {
  startMockApi,
  type CapturedRequest,
  type MockApi,
  type MockRoute,
} from "./helpers/mock-api.ts";

const SERVER_ENTRY = fileURLToPath(new URL("../dist/server.js", import.meta.url));
const SERVER_PACKAGE = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const MARKDOWN = "# Quarterly numbers\n\n- one\n- two\n";
const COMMAND_EXPORT = "makespdf.exportToPdf";
const COMMAND_VALIDATE = "makespdf.validateAccessibility";

function header(request: CapturedRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function messages(client: LspClient): any[] {
  return client.notificationsFor("window/showMessage") as any[];
}

interface Harness {
  client: LspClient;
  api: MockApi;
  dir: string;
  uri: string;
  settings: Record<string, unknown>;
  applySettings(partial: Record<string, unknown>): void;
  dispose(): Promise<void>;
}

async function startHarness(options: {
  routes: MockRoute[];
  settings?: Record<string, unknown>;
}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "makespdf-zed-"));
  const mdPath = join(dir, "report.md");
  await writeFile(mdPath, MARKDOWN);
  const uri = pathToFileURL(mdPath).toString();

  const api = await startMockApi(options.routes);
  const settings: Record<string, unknown> = {
    serviceUrl: api.url,
    apiToken: "",
    pageSize: "A4",
    fontFamily: "Inter",
    fontSize: 10,
    margins: [40, 40, 40, 40],
    ...options.settings,
  };

  const client = new LspClient(process.execPath, [SERVER_ENTRY, "--stdio"]);
  client.onRequest = (method, params) => {
    if (method === "workspace/configuration") return [settings];
    // Choosing "Report problem" on an error dialog is what a user would do.
    // Dialogs without that action are dismissed.
    if (method === "window/showMessageRequest") {
      const actions = (params as any)?.actions ?? [];
      return actions.find((action: any) => action.title === "Report problem") ?? null;
    }
    return null;
  };

  await client.request("initialize", {
    processId: process.pid,
    rootUri: pathToFileURL(dir).toString(),
    capabilities: { workspace: { configuration: true } },
  });
  client.notify("initialized", {});
  // The server pulls settings on `initialized`; wait until that exchange has
  // happened so the push below is applied on top of a completed pull.
  await client.waitForServerRequest("workspace/configuration");
  client.notify("textDocument/didOpen", {
    textDocument: { uri, languageId: "markdown", version: 1, text: MARKDOWN },
  });
  // Push the same settings; the push is applied synchronously by the command
  // handlers, which removes any race with the initial asynchronous pull.
  client.notify("workspace/didChangeConfiguration", {
    settings: { makespdf: settings },
  });

  return {
    client,
    api,
    dir,
    uri,
    settings,
    applySettings(partial) {
      Object.assign(settings, partial);
      client.notify("workspace/didChangeConfiguration", {
        settings: { makespdf: settings },
      });
    },
    async dispose() {
      await client.dispose();
      await api.close();
    },
  };
}

async function codeActions(harness: Harness): Promise<any[]> {
  return (await harness.client.request("textDocument/codeAction", {
    textDocument: { uri: harness.uri },
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    context: { diagnostics: [] },
  })) as any[];
}

function finishedCount(harness: Harness, command: string): number {
  return (harness.client.notificationsFor("window/logMessage") as any[]).filter(
    (params) => params.message === `makesPDF: ${command} finished`,
  ).length;
}

/**
 * Execute a command and wait for it to finish. The server answers
 * `workspace/executeCommand` at once and runs the command detached, logging
 * `makesPDF: <command> finished` when it is done.
 */
async function execute(harness: Harness, command: string): Promise<void> {
  const before = finishedCount(harness, command);
  const reply = await harness.client.request("workspace/executeCommand", {
    command,
    arguments: [harness.uri],
  });
  assert.equal(reply, null, "executeCommand is answered before the command runs");
  const deadline = Date.now() + 15_000;
  while (finishedCount(harness, command) <= before) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${command} to finish`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Log lines other than the "finished" markers. */
function issueLogs(client: LspClient): any[] {
  return (client.notificationsFor("window/logMessage") as any[]).filter(
    (params) => !/ finished$/.test(params.message),
  );
}

test("codeAction offers Export (and Validate only with a token); Export writes the mock bytes and sends the client header", async () => {
  const pdfBytes = Buffer.from("%PDF-1.4 mock-bytes\n");
  const harness = await startHarness({
    routes: [
      {
        path: "/api/v1/md",
        reply: {
          status: 200,
          headers: {
            "X-Pages": "1",
            "X-Render-Ms": "12",
            "X-MakesPDF-Tip": "Create an account for higher limits.",
          },
          body: pdfBytes,
        },
      },
    ],
  });
  try {
    // Validate has no anonymous access, so it is hidden without a token.
    const anonymous = await codeActions(harness);
    assert.deepEqual(
      anonymous.map((action) => action.title),
      ["Export to PDF"],
    );
    assert.equal(anonymous[0].command.command, COMMAND_EXPORT);
    assert.deepEqual(anonymous[0].command.arguments, [harness.uri]);

    await execute(harness, COMMAND_EXPORT);

    assert.deepEqual(await readFile(join(harness.dir, "report.pdf")), pdfBytes);

    const render = harness.api.requestsFor("/api/v1/md");
    assert.equal(render.length, 1);
    const request = render[0]!;
    assert.equal(
      header(request, "x-makespdf-client"),
      `zed/${SERVER_PACKAGE.version}`,
    );
    assert.equal(header(request, "authorization"), undefined);
    assert.equal(request.json.markdown, MARKDOWN);
    assert.deepEqual(request.json.options, {
      pageSize: "A4",
      fontFamily: "Inter",
      fontSize: 10,
      margins: [40, 40, 40, 40],
      title: "report",
    });

    const saved = messages(harness.client).find((params) => /PDF saved/.test(params.message));
    assert.ok(saved, "an info message reports the saved PDF");
    assert.match(saved.message, /report\.pdf/);
    assert.match(saved.message, /1 page, 12ms/);

    // The anonymous tip is surfaced once per session, not per render.
    await execute(harness, COMMAND_EXPORT);
    assert.equal(harness.api.requestsFor("/api/v1/md").length, 2);
    const tips = messages(harness.client).filter((params) =>
      /Create an account/.test(params.message),
    );
    assert.equal(tips.length, 1);

    harness.applySettings({ apiToken: "key_123" });
    const authed = await codeActions(harness);
    assert.deepEqual(
      authed.map((action) => action.title),
      ["Export to PDF", "Validate accessibility"],
    );
    assert.deepEqual(
      authed.map((action) => action.command.command),
      [COMMAND_EXPORT, COMMAND_VALIDATE],
    );
    for (const action of authed) {
      assert.deepEqual(action.command.arguments, [harness.uri]);
    }
  } finally {
    await harness.dispose();
  }
});

test("Export sends no Authorization without a token and Bearer with one", async () => {
  const harness = await startHarness({
    routes: [
      {
        path: "/api/v1/md",
        reply: { status: 200, body: Buffer.from("%PDF-1.4 second\n") },
      },
    ],
  });
  try {
    await execute(harness, COMMAND_EXPORT);
    harness.applySettings({ apiToken: "key_123" });
    await execute(harness, COMMAND_EXPORT);

    const renders = harness.api.requestsFor("/api/v1/md");
    assert.equal(renders.length, 2);
    assert.equal(header(renders[0]!, "authorization"), undefined);
    assert.equal(header(renders[1]!, "authorization"), "Bearer key_123");
  } finally {
    await harness.dispose();
  }
});

test("Validate shows the issue summary and logs each issue", async () => {
  const harness = await startHarness({
    settings: { apiToken: "key_v" },
    routes: [
      {
        path: "/api/v1/md/validate",
        reply: {
          status: 200,
          body: JSON.stringify({
            valid: false,
            issues: [
              { severity: "error", message: "Heading level skipped", path: "kids[0]", rule: "a11y-heading-skip" },
              { severity: "warning", message: "Image missing alt text", path: "kids[1]", rule: "a11y-missing-alt" },
            ],
            summary: { errors: 1, warnings: 1 },
          }),
        },
      },
    ],
  });
  try {
    await execute(harness, COMMAND_VALIDATE);

    const summary = messages(harness.client).find((params) =>
      /1 error, 1 warning/.test(params.message),
    );
    assert.ok(summary, "the summary counts errors and warnings");
    assert.match(summary.message, /Heading level skipped/);
    assert.match(summary.message, /Image missing alt text/);

    const logs = issueLogs(harness.client);
    assert.equal(logs.length, 2);
    assert.deepEqual(
      logs.map((params) => params.type),
      [1, 2],
      "issues are logged as Error (1) and Warning (2)",
    );
    assert.match(logs[0]!.message, /a11y-heading-skip/);
    assert.match(logs[1]!.message, /a11y-missing-alt/);

    const validate = harness.api.requestsFor("/api/v1/md/validate");
    assert.equal(validate.length, 1);
    assert.equal(validate[0]!.json.markdown, MARKDOWN);
    assert.equal(
      header(validate[0]!, "x-makespdf-client"),
      `zed/${SERVER_PACKAGE.version}`,
    );
    assert.equal(header(validate[0]!, "authorization"), "Bearer key_v");
  } finally {
    await harness.dispose();
  }
});

test("a 500 export offers Report problem, and picking it POSTs the fingerprints", async () => {
  const harness = await startHarness({
    routes: [
      {
        path: "/api/v1/md",
        reply: {
          status: 500,
          body: JSON.stringify({ error: "boom went the renderer" }),
        },
      },
      {
        path: "/api/v1/feedback",
        reply: { status: 200, body: JSON.stringify({ feedbackId: "f1" }) },
      },
    ],
  });
  try {
    await execute(harness, COMMAND_EXPORT);

    const dialogs = harness.client.serverRequestsFor("window/showMessageRequest") as any[];
    const errorDialog = dialogs.find((params) => /HTML|HTTP 500|export failed/.test(params.message));
    assert.ok(errorDialog, "the export error is shown");
    assert.match(errorDialog.message, /boom went the renderer/);
    assert.deepEqual(
      errorDialog.actions.map((action: any) => action.title),
      ["Report problem"],
    );

    const feedback = harness.api.requestsFor("/api/v1/feedback");
    assert.equal(feedback.length, 1);
    const request = feedback[0]!;
    assert.equal(header(request, "x-makespdf-client"), `zed/${SERVER_PACKAGE.version}`);
    assert.equal(header(request, "authorization"), undefined);
    assert.equal(request.json.kind, "problem");
    assert.equal(request.json.context.httpStatus, 500);
    assert.equal(request.json.context.pageSize, "A4");
    assert.ok(request.json.context.inputBytes > 0);
    assert.equal(
      request.json.context.errorCode,
      undefined,
      "sentence-shaped server errors are not forwarded",
    );
    assert.ok(!request.body.includes("boom"), "server error text is not sent");
    assert.ok(!request.body.includes("Quarterly"), "document text is not sent");
    assert.ok(!request.body.includes("report.md"), "file name is not sent");
    assert.match(request.json.message, /^Export failed in the Zed extension \(HTTP 500\)\.$/);

    const thanks = messages(harness.client).find((params) =>
      /thanks, feedback sent/.test(params.message),
    );
    assert.ok(thanks, "feedback submission is confirmed");
    assert.ok(!harness.api.requestsFor("/api/v1/md/validate").length);
  } finally {
    await harness.dispose();
  }
});
