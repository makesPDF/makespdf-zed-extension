use zed_extension_api::{self as zed, settings::LspSettings, LanguageServerId, Result};

/// The npm package that holds the makesPDF language server.
const NPM_PACKAGE: &str = "@makespdf/zed-language-server";

/// Entry point of the server inside the installed npm package. This is a path
/// relative to the extension's working directory, where Zed installs the
/// package (see `npm_install_package`).
const SERVER_ENTRY: &str = "node_modules/@makespdf/zed-language-server/dist/server.js";

struct MakesPdfExtension;

impl MakesPdfExtension {
    /// Install or update the sidecar and return the path to its entry point.
    fn server_entry(language_server_id: &LanguageServerId) -> Result<String> {
        let installed = zed::npm_package_installed_version(NPM_PACKAGE)?;

        match zed::npm_package_latest_version(NPM_PACKAGE) {
            Ok(latest) => {
                if installed.as_deref() != Some(latest.as_str()) {
                    zed::set_language_server_installation_status(
                        language_server_id,
                        &zed::LanguageServerInstallationStatus::Downloading,
                    );
                    zed::npm_install_package(NPM_PACKAGE, &latest).map_err(|error| {
                        format!("failed to install {NPM_PACKAGE}@{latest}: {error}")
                    })?;
                }
            }
            // No registry reachable. A version already on disk still works;
            // with nothing installed there is nothing to run, so say so.
            Err(error) => {
                if installed.is_none() {
                    return Err(format!(
                        "could not reach the npm registry to install {NPM_PACKAGE}: {error}"
                    ));
                }
            }
        }

        Ok(SERVER_ENTRY.to_string())
    }
}

impl zed::Extension for MakesPdfExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        _worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        zed::set_language_server_installation_status(
            language_server_id,
            &zed::LanguageServerInstallationStatus::CheckingForUpdate,
        );

        let server_entry = Self::server_entry(language_server_id)?;

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
