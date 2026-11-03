---
name: copilot-setup
description: Set up or switch this plugin's local Copilot model provider using accounts already signed in on the machine, including GitHub Enterprise Cloud accounts. Also use to diagnose or remove this provider.
---

Use the bundled CLI at `../../dist/cli.mjs` relative to this skill directory. Resolve its absolute installed path before invoking it. The installed package may differ from its source checkout.

For first setup or an account/model switch, run `node <absolute-cli-path> setup`. This opens a protected local account selector in the user's browser. The user selects an existing account and Responses model, then applies the choice. Wait for the user to finish or use `status` to check; do not choose an account for them or ask them to paste a token. The setup flow updates only the provider/model settings, records a backup, and leaves sandbox and approval policies alone. Tell the user to restart Codex after applying settings.

The runtime reuses existing credentials from supported local stores. `accounts` lists only host, username, and source metadata. Never read, print, or paste credential file contents or run the internal `token` command in chat. If no usable account exists, explain which sources were checked and have the user sign in using their existing Copilot/GitHub client. This plugin does not silently start a new OAuth login or change the active account in another app.

If a user requests an additional existing credential file, `add-credential-file <absolute-path>` registers that source without copying its token. Then reopen setup. Do not search unrelated user files for credentials.

For automatic session startup, direct the user to **Settings → Hooks** (or **Review hooks**) to trust this plugin's hook. Trust belongs to the host; never edit its trust store or bypass it. The hook is a session event, not a global application-start event. The provider auth helper also starts the service when Codex requests its local gateway key.

Use `status` to diagnose the chosen account/model and service readiness. `stop` explicitly stops only this plugin's authenticated service. Before uninstalling, run `restore` to undo the plugin's provider changes while preserving other configuration edits, then remove the plugin from the app. If restore reports a conflict, show the affected setting and preserve the user's files.

These features apply to local Codex sessions, including supported desktop surfaces. They do not replace the backend of ordinary cloud ChatGPT conversations. A listed GitHub identity is not proof of Copilot entitlement; setup verifies model access before applying it.
