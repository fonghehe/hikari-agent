# Hikari Workspace for VS Code

Start Hikari remote control for the same project, or run `pnpm agent serve 4319` from a configured Hikari checkout. In VS Code, run **Hikari: Connect to Local Host**, enter the URL and paste its private access token. Credentials are stored in VS Code SecretStorage.

The **Hikari Tasks** view can start tasks with the active file's selection and diagnostics, read results, pause/resume/cancel execution, send additional instructions, answer questions, approve operations and open the current diff. A trusted local workspace matching the execution host is required. Unsaved selections are reference context, not replacements for on-disk files.

For another machine, use HTTPS or an SSH tunnel to a loopback address. Never put the token in a URL, source file or workspace setting.

Build with `pnpm vscode:pack` in the Hikari repository, then use **Extensions: Install from VSIX** and select `release/hikari-workspace-0.1.0.vsix`. The extension uses only the stable VS Code API and has no bundled runtime dependencies. A running Hikari host and a configured model are required.
