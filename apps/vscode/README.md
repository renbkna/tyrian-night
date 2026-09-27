# Tyrian Night for VS Code

Tyrian Night provides six generated VS Code color themes:

- **Night** — the quiet, low-energy dark variant;
- **Nocturne** — the canonical tempered-cosmic center;
- **Pastel** — the independent soft-focus branch;
- **Abyss** — the deeper, more chromatic dark variant;
- **Dawn** — the related light counterpart;
- **Night Old** — the historical reference translated onto the current theme contract.

The projection covers a curated set of documented public VS Code colors for control states, selection and keyboard focus, chat and inline chat, notebooks, testing, terminal symbol icons, gauges, and agent-session indicators. High-contrast-only borders, shadows, and opacity controls intentionally keep VS Code defaults.

## Support

- Color themes and the packaged extension support VS Code 1.118 or newer on Linux, macOS, and Windows.
- Island UI (Apply, Repair, Restore Classic UI, and Doctor) supports Linux, macOS, and Windows. VS Code must be installed where your user account can write it: a per-user install on Windows, not one under `Program Files`.
- Tyrian never requests administrator privileges or changes file ownership or permissions.

The color themes use the normal VS Code extension contract. Merely installing or selecting a theme does not modify the VS Code application.

## Install and select a theme

1. Open the Extensions panel and install **Tyrian Night**.
2. Run **Preferences: Color Theme**.
3. Select a Tyrian theme.

The repository includes a [`settings.example.json`](https://github.com/renbkna/tyrian-night/blob/HEAD/apps/vscode/settings.example.json) companion for typography and editor preferences. It is not applied automatically.

Tyrian keeps VS Code semantic highlighting disabled by theme default so language-server overlays do not replace callable TextMate scopes with readonly-variable colors. The companion settings use `configuredByTheme`, preserving that choice for Tyrian without forcing it on other themes.

## Island UI

Island UI is an optional workbench patch for VS Code on Linux, macOS, and Windows. On any other platform the commands report unsupported and change nothing, and startup reconciliation is skipped.

Every Island change holds one per-user lock that the operating system releases when the process exits: `flock` on Linux and `lockf` on macOS, both on `~/.tyrian-night/island.lock`, and a named pipe on Windows. A second VS Code window waits for the first. Startup reconciliation and Repair read the installation's desired style and act on it while holding that lock, so a window that starts during another window's Apply cannot revert it. Each file is replaced atomically, so no file is ever partial or missing. Apply writes the stylesheet before the `workbench.html` link that loads it, and Restore removes the link before the stylesheet, so an interrupted command leaves VS Code loadable; running the same command again completes it. Doctor reports an interrupted state as broken or checksum-mismatched and recommends that command.

> [!WARNING]
> Before uninstalling Tyrian Night, run **Tyrian Night: Restore Classic UI**, reload VS Code, and confirm that the custom UI is gone. Uninstalling the extension alone cannot remove an active patch.

Commands:

- **Tyrian Night: Apply Island UI**
- **Tyrian Night: Repair Island UI**
- **Tyrian Night: Restore Classic UI**
- **Tyrian Night: Doctor Island UI**

Apply preflights the canonical application root, desired stylesheet, current patch, backup receipts, checksums, and write access. It then updates one stylesheet link in `workbench.html`, one CSS file, and the matching `product.json` checksum. A target that changed after planning, such as during a VS Code update, stops the command before it is overwritten.

Tyrian stores backups beside the patched files and records the exact physical application root and hashes in a manifest. Restore accepts backups only when the complete receipt proves they belong to the current patch; otherwise it removes Tyrian-owned evidence and repairs the checksum.

Package-managed VS Code installations may make application files read-only. Fix permissions through the package or system administrator, then retry Repair or Restore. Tyrian reports permission and partial-cleanup failures instead of claiming success.

VS Code may display “Your installation appears to be corrupt” while Island UI is active because `workbench.html` is intentionally patched.

Island UI is based on [vscode-dark-islands](https://github.com/bwya77/vscode-dark-islands) by [bwya77](https://github.com/bwya77).

## Build this product

From the repository root:

```sh
bun install --frozen-lockfile
bun run verify:vscode
bun run package:vscode
```

`apps/vscode/package.json` owns extension metadata, dependencies, build output, and the strict marketplace file allowlist. The root package only orchestrates the workspace.

## License

[Apache License 2.0](https://github.com/renbkna/tyrian-night/blob/HEAD/LICENSE)
