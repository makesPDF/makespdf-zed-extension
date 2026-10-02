# Changelog

## 0.1.0

Initial release.

- **Export to PDF** code action: posts the current Markdown buffer to `/api/v1/md` and writes `<name>.pdf` next to the source file, overwriting it. Images referenced by a local relative or absolute path are embedded as `data:` URIs first (the service cannot reach the user's filesystem); unreadable images and images over the 5MB per-image limit are left as references and named in one non-fatal warning.
- **Validate accessibility** code action: posts to `/api/v1/md/validate` and shows the issue summary (errors, warnings, first messages), logging each issue. Offered only when an `apiToken` is configured, since the endpoint has no anonymous access. It does not embed local images.
- **Report problem** on a failed export: posts the failure fingerprints (HTTP status, code-shaped error code, page size, font family, font size, input bytes) to `/api/v1/feedback`; never the document text or file name.
- Settings under `lsp.makespdf.settings` mirror the VS Code plugin's defaults, including `serviceUrl`, `apiToken`, `pageSize`, `fontFamily`, `fontSize` and `margins`.
- Every request sends `X-MakesPDF-Client: zed/<version>`; with an `apiToken` configured, requests also carry `Authorization: Bearer <token>`, but only to makesPDF's own origins and loopback addresses.
- Commands run in the background: `workspace/executeCommand` is answered at once, so a slow render or an open "Report problem" prompt cannot hit Zed's 120 s request timeout.
- A failed update of the language server package falls back to the installed version, and the npm registry is checked once per session.
