// The code actions offered on a Markdown document.
//
// Zed's extension API has no command palette, so the supported route is a
// code action whose `command` Zed dispatches through `workspace/executeCommand`
// (verified in zed/crates/project/src/lsp_store.rs, apply_code_action). Each
// action carries the document URI; the command handlers read the current
// buffer text from the open TextDocuments rather than the file on disk.

import { CodeAction, CodeActionKind } from "vscode-languageserver/node.js";

import { COMMAND_EXPORT, COMMAND_VALIDATE } from "./commands.ts";
import { isFileUri } from "./paths.ts";

export function buildCodeActions(documentUri: string): CodeAction[] {
  // Export writes next to the source file; a non-file document has no such
  // place, so neither action is offered.
  if (!isFileUri(documentUri)) return [];

  return [
    {
      title: "Export to PDF",
      kind: `${CodeActionKind.Source}.makespdf.exportToPdf`,
      command: {
        title: "Export to PDF",
        command: COMMAND_EXPORT,
        arguments: [documentUri],
      },
    },
    {
      title: "Validate accessibility",
      kind: `${CodeActionKind.Source}.makespdf.validateAccessibility`,
      command: {
        title: "Validate accessibility",
        command: COMMAND_VALIDATE,
        arguments: [documentUri],
      },
    },
  ];
}
