# makesPDF for Zed

Export the Markdown file you're editing to an accessible, archival-quality PDF (PDF/A-2A + PDF/UA-1) from [Zed](https://zed.dev), rendered by [makesPDF.com](https://makespdf.com) — no Chromium, no LaTeX, no local toolchain.

> **Work in progress.** Not yet published to the Zed extension directory; install it as a dev extension (see [Development](#development)).

## How it works

Zed's extension API has no command palette, event hooks or webviews, so makesPDF ships as a **language server for Markdown** whose code actions do the work:

- **Export to PDF** — posts the current buffer (not the file on disk) to makesPDF and writes the PDF next to the source file, overwriting `<name>.pdf`. Images referenced by a local relative or absolute path are embedded as `data:` URIs first, so they appear in the PDF. A message tells you where it went and how many pages it rendered.
- **Validate accessibility** — runs the same PDF/UA-1 content checks as the renderer (heading hierarchy, image alt text) without producing a PDF. The summary shows the error and warning counts plus the first few issues; every issue is written to the log.
- **Report problem** — if an export fails, the error dialog offers **Report problem**, which sends the failure's fingerprints (never your text) to makesPDF.

Rendering happens remotely; the language server does no network or disk work until you run a code action.

## Usage

Zed exposes extension commands as code actions:

1. Open a Markdown file.
2. Put the cursor in the editor and open the code actions menu — `cmd-.` on macOS, `ctrl-.` on Linux and Windows by default.
3. Pick **Export to PDF** or **Validate accessibility**.

If the shortcut does nothing on your machine, bind it in your Zed `keymap.json`:

```json
[
  {
    "bindings": {
      "cmd-alt-p": ["editor::ToggleCodeActions"]
    }
  }
]
```

**Validate accessibility needs an API token**: `POST /api/v1/md/validate` is authenticated, so the action only appears in the menu once `apiToken` is set. Export works anonymously within the limits below.

## Settings

Settings live under `lsp.makespdf.settings` in your Zed `settings.json` (same names, enums and defaults as the VS Code plugin's `makespdf.*` settings):

```json
{
  "lsp": {
    "makespdf": {
      "settings": {
        "serviceUrl": "https://makespdf.com",
        "apiToken": "",
        "pageSize": "A4",
        "fontFamily": "Inter",
        "fontSize": 10,
        "margins": [40, 40, 40, 40]
      }
    }
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `serviceUrl` | `https://makespdf.com` | URL of the PDF service. `apiToken` is only sent when this is `https://makespdf.com`, `https://staging.makespdf.com` or a `localhost` / `127.0.0.1` / `[::1]` address; any other URL gets anonymous requests. This stops a project's `.zed/settings.json` from pointing `serviceUrl` elsewhere and picking up the token from your user settings. |
| `apiToken` | `""` | Optional. Leave blank for the default per-IP limits (60/hour, 200/day, 20 pages per render). Paste a key to lift the limits, persist renders, and use **Validate accessibility**. Get one at [makespdf.com/settings/api-keys](https://makespdf.com/settings/api-keys). |
| `pageSize` | `A4` | A3, A4, A5, Letter, or Legal. |
| `fontFamily` | `Inter` | Inter or NotoSans. |
| `fontSize` | `10` | Font size in points (6–24). |
| `margins` | `[40, 40, 40, 40]` | Page margins in points `[top, right, bottom, left]`. |

## Limits and privacy

Documents up to 20 pages render out of the box, rate-limited to 60/hour and 200/day per IP. An API key removes the per-IP rate limit and the per-render page cap (the 200KB Markdown input cap still applies) and persists your PDFs to [makespdf.com/settings/renders](https://makespdf.com/settings/renders) for re-download. See [makespdf.com/pricing](https://makespdf.com/pricing); PDFs on the Free and Hobbyist plans include a small `makespdf.com` link at the bottom of the page.

Your Markdown crosses the network only when you run **Export to PDF** or **Validate accessibility**. An export also carries the bytes of the local images your Markdown references by path, embedded as `data:` URIs so the service can render them; **Validate accessibility** sends the Markdown alone, without image bytes. When you use **Report problem**, the message is built from the failure shape (HTTP status, error code, page size, font family, font size, document size in bytes) — never your Markdown, file name or path. The service stores feedback with a daily-salted hash of your IP address and your country code and keeps it until the makesPDF team deletes it; your IP address is also used, unhashed, for rate limiting.

Anonymous renders are not persisted to an account; named renders (with an API key) are stored so you can re-download them. See the [privacy policy](https://makespdf.com/legal/privacy).

**Local images are embedded on export.** An image referenced by a relative path (`![diagram](diagram.png)`) or an absolute path is read and embedded as a `data:` URI before the Markdown is sent, so the service can render it without filesystem access. Files larger than 5MB per image are left as plain references and named in a non-fatal warning; the same warning names references that could not be read. `http(s)` URLs are left for the service to fetch.

## Development

Layout:

- `extension.toml`, `Cargo.toml`, `src/lib.rs` — the WASM coordinator Zed loads. It registers the `makespdf` language server for Markdown, installs/updates the npm package `@makespdf/zed-language-server`, and runs it with Zed's Node (`node <package>/dist/server.js --stdio`), forwarding `lsp.makespdf.settings` as the `makespdf` workspace-configuration section.
- `server/` — the language server (TypeScript, bundled with esbuild).

Build and test:

```sh
cargo build --target wasm32-wasip2 --release   # the WASM extension

cd server
npm ci
npm test          # typecheck + unit tests + the stdio LSP integration test
npm run build     # bundle to server/dist/server.js
```

To try it in Zed before the package is published, launch Zed from a shell with the dev override set:

```sh
# from the repository root
MAKESPDF_ZED_SERVER_JS="$PWD/server/dist/server.js" zed
```

Then run `zed: install dev extension` from the command palette and pick this repository. Without the override, the extension installs `@makespdf/zed-language-server` into its own work directory with `npm_install_package` and updates it when a new version is published — that is the normal path, and `MAKESPDF_ZED_SERVER_JS` (an absolute path to a built `server/dist/server.js`) replaces it for development.

The npm package is released by pushing a `vX.Y.Z` tag (`.github/workflows/release.yml`, npm trusted publishing with provenance); publishing is out of scope for this repository's day-to-day changes.

## License

[MIT](./LICENSE)
