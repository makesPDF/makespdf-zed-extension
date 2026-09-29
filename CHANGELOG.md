# Changelog

## 0.1.0

Initial release.

- **Export to PDF** code action: posts the current Markdown buffer to `/api/v1/md` and writes `<name>.pdf` next to the source file, overwriting it.
- **Validate accessibility** code action: posts to `/api/v1/md/validate` and shows the issue summary (errors, warnings, first messages), logging each issue.
- **Report problem** on a failed export: posts the failure fingerprints (HTTP status, code-shaped error code, page size, font family, font size, input bytes) to `/api/v1/feedback`; never the document text or file name.
- Settings under `lsp.makespdf.settings` mirror the VS Code plugin's defaults, including `serviceUrl`, `apiToken`, `pageSize`, `fontFamily`, `fontSize` and `margins`.
- Every request sends `X-MakesPDF-Client: zed-extension/<version>`; with an `apiToken` configured, requests also carry `Authorization: Bearer <token>`.
