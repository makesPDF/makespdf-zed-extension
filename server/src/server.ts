// makesPDF language server for Zed.
//
// Zed's extension API has no command palette, so this server is the whole
// user-facing surface: it offers code actions on Markdown documents and runs
// their commands. Export posts the current buffer to makesPDF.com and writes
// the PDF next to the source file; validate reports accessibility issues.
//
// The server does no network or disk work until a command is executed.

import { writeFile } from "node:fs/promises";

import {
  CodeActionKind,
  createConnection,
  DidChangeConfigurationNotification,
  type ExecuteCommandParams,
  type InitializeParams,
  type InitializeResult,
  LogMessageNotification,
  MessageType,
  ProposedFeatures,
  ShowMessageNotification,
  TextDocuments,
  TextDocumentSyncKind,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";

import {
  apiUrl,
  classifyApiFailure,
  connectionFailureMessage,
  formatValidateSummary,
  markdownBody,
  optionsFromSettings,
  requestHeaders,
  RENDER_PATH,
  savedMessage,
  VALIDATE_PATH,
  type ValidateResult,
} from "./api.ts";
import { COMMAND_EXPORT, COMMAND_VALIDATE, SETTINGS_SECTION } from "./commands.ts";
import { buildCodeActions } from "./code-actions.ts";
import {
  buildProblemContext,
  problemReportMessage,
  sendFeedback,
  type RenderFailureFacts,
} from "./feedback.ts";
import { isFileUri, pdfTarget } from "./paths.ts";
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  sendableToken,
  type MakesPdfSettings,
} from "./settings.ts";
import { SERVER_VERSION } from "./version.ts";

const REPORT_PROBLEM = "Report problem";
const ISSUES_URL = "https://github.com/makesPDF/makespdf-zed-extension/issues";
const REQUEST_TIMEOUT_MS = 120_000;

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments<TextDocument>(TextDocument);

let settings: MakesPdfSettings = { ...DEFAULT_SETTINGS };
let supportsPull = false;
/** The anonymous-render tip is surfaced once per server (Zed session). */
let anonymousTipShown = false;
/** The withheld-token warning is surfaced once per server (Zed session). */
let withheldTokenWarned = false;

// Plain `window/showMessage` notifications for outcomes with nothing to click.
// (`connection.window.showInformationMessage` would send a showMessageRequest,
// which the task reserves for the "Report problem" action.)
function showMessage(type: MessageType, message: string): void {
  void connection.sendNotification(ShowMessageNotification.type, { type, message });
}

function showInfo(message: string): void {
  showMessage(MessageType.Info, message);
}

function showWarning(message: string): void {
  showMessage(MessageType.Warning, message);
}

function showError(message: string): void {
  showMessage(MessageType.Error, message);
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
  supportsPull = params.capabilities?.workspace?.configuration === true;
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      codeActionProvider: { codeActionKinds: [CodeActionKind.Source] },
      executeCommandProvider: { commands: [COMMAND_EXPORT, COMMAND_VALIDATE] },
    },
  };
});

connection.onInitialized(async () => {
  if (!supportsPull) return;
  try {
    await connection.client.register(DidChangeConfigurationNotification.type, undefined);
  } catch {
    // Client lacks dynamic registration — settings then arrive via push only.
  }
  await pullSettings();
});

connection.onDidChangeConfiguration(async (params) => {
  const pushed = (params.settings ?? {}) as Record<string, unknown>;
  settings = mergeSettings(pushed[SETTINGS_SECTION] ?? pushed);
  await pullSettings();
});

async function pullSettings(): Promise<void> {
  if (!supportsPull) return;
  try {
    settings = mergeSettings(await connection.workspace.getConfiguration(SETTINGS_SECTION));
  } catch (error) {
    connection.console.warn(`makesPDF: could not read settings: ${String(error)}`);
  }
}

connection.onCodeAction((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];
  return buildCodeActions(document.uri, { validate: Boolean(sendableToken(settings)) });
});

// Answer `workspace/executeCommand` at once and run the command detached.
// Zed times the request out after 120 s (`request_timeout`), and an export
// can take that long on its own, before a "Report problem" prompt then waits
// for the user inside the same handler.
connection.onExecuteCommand((params: ExecuteCommandParams) => {
  void runCommand(params);
  return null;
});

async function runCommand(params: ExecuteCommandParams): Promise<void> {
  try {
    const uri = firstStringArgument(params.arguments);
    if (!uri) {
      showError("makesPDF: missing document URI.");
      return;
    }
    if (params.command === COMMAND_EXPORT) {
      await exportToPdf(uri);
    } else if (params.command === COMMAND_VALIDATE) {
      await validateAccessibility(uri);
    }
  } catch (error) {
    showError(
      `makesPDF: unexpected error: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    // Marks the end of a detached command in the language server log; the
    // integration tests wait on it.
    void connection.sendNotification(LogMessageNotification.type, {
      type: MessageType.Log,
      message: `makesPDF: ${params.command} finished`,
    });
  }
}

/**
 * The token for this request. A configured token that `serviceUrl` may not
 * receive is withheld (see `tokenAllowedFor`), and the user is told once.
 */
function requestToken(): string {
  const token = sendableToken(settings);
  if (settings.apiToken && !token && !withheldTokenWarned) {
    withheldTokenWarned = true;
    showWarning(
      `makesPDF: apiToken is only sent to makespdf.com or a localhost server, so requests to ${settings.serviceUrl} go without it.`,
    );
  }
  return token;
}

function firstStringArgument(args: ExecuteCommandParams["arguments"]): string | undefined {
  const first = args?.[0];
  return typeof first === "string" ? first : undefined;
}

/** POST the current buffer to /api/v1/md and write the bytes next to the file. */
async function exportToPdf(uri: string): Promise<void> {
  const document = documents.get(uri);
  if (!document) {
    showError("makesPDF: this document is not open in the editor.");
    return;
  }
  if (!isFileUri(uri)) {
    showError("makesPDF: only local files can be exported.");
    return;
  }

  const markdown = document.getText();
  if (!markdown.trim()) {
    showWarning("makesPDF: document is empty.");
    return;
  }

  const { title, pdfPath } = pdfTarget(uri);
  const options = optionsFromSettings(settings, title);
  const apiToken = requestToken();
  // Fingerprints for "Report problem": sizes and settings, never the text or
  // the file name. The failure's status and code are added below.
  const facts: RenderFailureFacts = {
    pageSize: options.pageSize,
    fontFamily: options.fontFamily,
    fontSize: options.fontSize,
    inputBytes: Buffer.byteLength(markdown),
  };

  let response: Response;
  try {
    response = await fetch(apiUrl(settings.serviceUrl, RENDER_PATH), {
      method: "POST",
      headers: requestHeaders(SERVER_VERSION, apiToken),
      body: markdownBody(markdown, options),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    await reportExportProblem(
      connectionFailureMessage("export", settings.serviceUrl, error),
      facts,
      apiToken,
    );
    return;
  }

  if (!response.ok) {
    facts.httpStatus = response.status;
    const failure = classifyApiFailure({
      operation: "export",
      status: response.status,
      apiToken,
      serviceUrl: settings.serviceUrl,
      body: await readJsonBody(response),
    });
    facts.errorCode = failure.errorCode;
    await reportExportProblem(failure.message, facts, apiToken);
    return;
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(pdfPath, bytes);
  showInfo(
    savedMessage(pdfPath, response.headers.get("X-Pages"), response.headers.get("X-Render-Ms")),
  );

  // Surface the server's upsell hint once per session, anonymous renders only.
  const tip = apiToken ? null : response.headers.get("X-MakesPDF-Tip");
  if (tip && !anonymousTipShown) {
    anonymousTipShown = true;
    showInfo(`makesPDF: ${tip}`);
  }
}

/** POST the current buffer to /api/v1/md/validate and report the issues. */
async function validateAccessibility(uri: string): Promise<void> {
  const document = documents.get(uri);
  if (!document) {
    showError("makesPDF: this document is not open in the editor.");
    return;
  }
  if (!isFileUri(uri)) {
    showError("makesPDF: only local files can be validated.");
    return;
  }

  const markdown = document.getText();
  if (!markdown.trim()) {
    showWarning("makesPDF: document is empty.");
    return;
  }

  const options = optionsFromSettings(settings, pdfTarget(uri).title);
  const apiToken = requestToken();

  let response: Response;
  try {
    response = await fetch(apiUrl(settings.serviceUrl, VALIDATE_PATH), {
      method: "POST",
      headers: requestHeaders(SERVER_VERSION, apiToken),
      body: markdownBody(markdown, options),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    showError(connectionFailureMessage("validate", settings.serviceUrl, error));
    return;
  }

  if (!response.ok) {
    const failure = classifyApiFailure({
      operation: "validate",
      status: response.status,
      apiToken,
      serviceUrl: settings.serviceUrl,
      body: await readJsonBody(response),
    });
    showError(failure.message);
    return;
  }

  const result = (await readJsonBody(response)) as ValidateResult;
  showInfo(`makesPDF: ${formatValidateSummary(result)}`);

  for (const issue of Array.isArray(result.issues) ? result.issues : []) {
    const type =
      issue.severity === "error"
        ? MessageType.Error
        : issue.severity === "warning"
          ? MessageType.Warning
          : MessageType.Info;
    const where = issue.path ? ` at ${issue.path}` : "";
    await connection.sendNotification(LogMessageNotification.type, {
      type,
      message: `makesPDF: ${issue.rule ?? "issue"}${where}: ${issue.message ?? ""}`,
    });
  }
}

/**
 * Show a failed export, offering "Report problem". Picking it POSTs the
 * fingerprints to /api/v1/feedback — never the document or the server's
 * error text, which can quote request content.
 */
async function reportExportProblem(
  message: string,
  facts: RenderFailureFacts,
  apiToken: string,
): Promise<void> {
  const choice = await connection.window.showErrorMessage(message, {
    title: REPORT_PROBLEM,
  });
  if (choice?.title !== REPORT_PROBLEM) return;

  const result = await sendFeedback({
    serviceUrl: settings.serviceUrl,
    version: SERVER_VERSION,
    apiToken,
    kind: "problem",
    message: problemReportMessage(facts),
    context: buildProblemContext(facts),
  });

  if (result.status === "sent") {
    showInfo("makesPDF: thanks, feedback sent.");
  } else if (result.status === "rate-limited") {
    showWarning("makesPDF: too many feedback messages, try again later.");
  } else {
    showError(
      `makesPDF: could not send feedback: ${result.error}. You can open an issue at ${ISSUES_URL}.`,
    );
  }
}

async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

documents.listen(connection);
connection.listen();
