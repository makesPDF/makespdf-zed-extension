// Document URI helpers. Only `file://` documents can be exported: the PDF is
// written next to the source file and the server resolves images relative to
// that directory, neither of which exists for an unsaved or remote document.

import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function isFileUri(uri: string): boolean {
  return uri.startsWith("file://");
}

/** Directory containing the document, for resolving relative image paths. */
export function fileDir(uri: string): string {
  return dirname(fileURLToPath(uri));
}

export interface PdfTarget {
  /** Output path: `<same dir as the source>/<base name>.pdf`. */
  pdfPath: string;
  /** Title sent to the renderer: the source file's base name. */
  title: string;
}

/** Resolve a `file://` document URI to its PDF output path and title. */
export function pdfTarget(uri: string): PdfTarget {
  const fsPath = fileURLToPath(uri);
  const title = basename(fsPath, extname(fsPath));
  return { title, pdfPath: join(dirname(fsPath), `${title}.pdf`) };
}
