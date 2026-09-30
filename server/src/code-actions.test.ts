import { test } from "node:test";
import assert from "node:assert/strict";
import { COMMAND_EXPORT, COMMAND_VALIDATE } from "./commands.ts";
import { buildCodeActions } from "./code-actions.ts";
import { isFileUri, pdfTarget } from "./paths.ts";

test("a file:// Markdown document offers Export and Validate", () => {
  const uri = "file:///tmp/notes/readme.md";
  const actions = buildCodeActions(uri, { validate: true });
  assert.deepEqual(
    actions.map((action) => action.title),
    ["Export to PDF", "Validate accessibility"],
  );
  assert.deepEqual(
    actions.map((action) => action.command?.command),
    [COMMAND_EXPORT, COMMAND_VALIDATE],
  );
  for (const action of actions) {
    assert.match(action.kind ?? "", /^source\./);
    assert.deepEqual(action.command?.arguments, [uri]);
  }
});

test("Validate is hidden when no token can be sent", () => {
  const actions = buildCodeActions("file:///tmp/notes/readme.md", { validate: false });
  assert.deepEqual(
    actions.map((action) => action.title),
    ["Export to PDF"],
  );
});

test("a non-file document is offered nothing", () => {
  assert.deepEqual(buildCodeActions("untitled:Untitled-1", { validate: true }), []);
  assert.deepEqual(buildCodeActions("https://example.com/readme.md", { validate: true }), []);
  assert.equal(isFileUri("https://example.com/readme.md"), false);
  assert.equal(isFileUri("file:///tmp/a.md"), true);
});

test("the PDF is written next to the source with the same base name", () => {
  assert.deepEqual(pdfTarget("file:///tmp/notes/readme.md"), {
    title: "readme",
    pdfPath: "/tmp/notes/readme.pdf",
  });
  assert.deepEqual(pdfTarget("file:///tmp/notes/My%20Notes.markdown"), {
    title: "My Notes",
    pdfPath: "/tmp/notes/My Notes.pdf",
  });
  assert.deepEqual(pdfTarget("file:///tmp/notes/no-extension"), {
    title: "no-extension",
    pdfPath: "/tmp/notes/no-extension.pdf",
  });
});
