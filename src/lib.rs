use std::{env, fs};

use zed_extension_api::{self as zed, settings::LspSettings, LanguageServerId, Result};

/// The npm package that holds the makesPDF language server.
const NPM_PACKAGE: &str = "@makespdf/zed-language-server";

/// Entry point of the server inside the installed npm package, relative to the
/// extension's working directory, where Zed installs the package (see
/// `npm_install_package`).
const SERVER_ENTRY: &str = "node_modules/@makespdf/zed-language-server/dist/server.js";

/// Dev override: an absolute path to a locally built `server/dist/server.js`.
/// When set in the shell environment Zed inherits, it replaces the npm package,
/// so the sidecar can be used before it is published.
const DEV_SERVER_ENV: &str = "MAKESPDF_ZED_SERVER_JS";

struct MakesPdfExtension {
    /// Set once the sidecar has been found on disk after an update check, so
    /// later server starts in this session skip the npm registry.
    did_find_server: bool,
}

fn server_exists() -> bool {
    fs::metadata(SERVER_ENTRY).is_ok_and(|metadata| metadata.is_file())
}

impl MakesPdfExtension {
    /// Install or update the sidecar and return the path to its entry point.
    ///
    /// An update that fails (registry unreachable, tarball or disk error)
    /// falls back to the version already installed; only a missing sidecar
    /// is an error.
    fn server_entry(&mut self, language_server_id: &LanguageServerId) -> Result<String> {
        if self.did_find_server && server_exists() {
            return Self::entry_path();
        }

        zed::set_language_server_installation_status(
            language_server_id,
            &zed::LanguageServerInstallationStatus::CheckingForUpdate,
        );

        let installed = zed::npm_package_installed_version(NPM_PACKAGE)?;
        let update_error = match zed::npm_package_latest_version(NPM_PACKAGE) {
            Ok(latest) if installed.as_deref() != Some(latest.as_str()) => {
                zed::set_language_server_installation_status(
                    language_server_id,
                    &zed::LanguageServerInstallationStatus::Downloading,
                );
                zed::npm_install_package(NPM_PACKAGE, &latest)
                    .err()
                    .map(|error| format!("failed to install {NPM_PACKAGE}@{latest}: {error}"))
            }
            Ok(_) => None,
            Err(error) => Some(format!(
                "could not reach the npm registry to install {NPM_PACKAGE}: {error}"
            )),
        };

        if !server_exists() {
            return Err(update_error.unwrap_or_else(|| {
                format!("the installed {NPM_PACKAGE} package does not contain {SERVER_ENTRY}")
            }));
        }

        self.did_find_server = true;
        Self::entry_path()
    }

    /// The installed entry point as an absolute path.
    ///
    /// The language server process runs with the project root as its working
    /// directory (`lsp_store.rs` passes the worktree path to
    /// `LanguageServer::new`, which sets `current_dir`), and Zed resolves only
    /// `command.command` against the extension directory — never arguments.
    /// The relative `SERVER_ENTRY` must therefore be joined with this
    /// extension's working directory (its WASI cwd), exactly as the official
    /// `html` extension does with `env::current_dir`.
    fn entry_path() -> Result<String> {
        let directory = env::current_dir()
            .map_err(|error| format!("could not read the extension directory: {error}"))?;
        Ok(directory.join(SERVER_ENTRY).to_string_lossy().into_owned())
    }
}

impl zed::Extension for MakesPdfExtension {
    fn new() -> Self {
        Self {
            did_find_server: false,
        }
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        // Dev override: run a locally built server instead of the npm package.
        if let Some(path) = worktree
            .shell_env()
            .iter()
            .find(|(key, _)| key == DEV_SERVER_ENV)
            .map(|(_, value)| value.clone())
        {
            return Ok(zed::Command {
                command: zed::node_binary_path()?,
                args: vec![path, "--stdio".to_string()],
                env: Default::default(),
            });
        }

        let server_entry = self.server_entry(language_server_id)?;

        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![server_entry, "--stdio".to_string()],
            env: Default::default(),
        })
    }

    fn language_server_workspace_configuration(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<zed::serde_json::Value>> {
        // Hand the user's `lsp.makespdf.settings` object to the sidecar under
        // the `makespdf` section it asks for via `workspace/configuration`.
        let settings = LspSettings::for_worktree(language_server_id.as_ref(), worktree)
            .ok()
            .and_then(|settings| settings.settings)
            .unwrap_or_else(|| zed::serde_json::json!({}));

        Ok(Some(zed::serde_json::json!({ "makespdf": settings })))
    }
}

zed::register_extension!(MakesPdfExtension);
