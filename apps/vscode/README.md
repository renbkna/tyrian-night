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
- Island UI apply and repair support Linux only.
- Doctor and Restore Classic UI remain available on every platform for current managed installations. A pending version 5 exchange journal needs Linux with GNU `mv` before Restore can recover it.
- Tyrian never requests administrator privileges or changes file ownership or permissions.

The color themes use the normal VS Code extension contract. Merely installing or selecting a theme does not modify the VS Code application.

## Install and select a theme

1. Open the Extensions panel and install **Tyrian Night**.
2. Run **Preferences: Color Theme**.
3. Select a Tyrian theme.

The repository includes a [`settings.example.json`](https://github.com/renbkna/tyrian-night/blob/HEAD/apps/vscode/settings.example.json) companion for typography and editor preferences. It is not applied automatically.

Tyrian keeps VS Code semantic highlighting disabled by theme default so language-server overlays do not replace callable TextMate scopes with readonly-variable colors. The companion settings use `configuredByTheme`, preserving that choice for Tyrian without forcing it on other themes.

## Island UI

Island UI is an optional Linux-only workbench patch. Apply and Repair refuse unsupported platforms before filesystem or desired-state admission.

Apply and Repair require GNU `mv` with `--exchange` and `--no-copy` so existing VS Code files can be replaced atomically; systems without that capability report unsupported before writing application files. Classic Restore selects the same version 5 exchange protocol when it is available. On Linux without that capability, and on the existing portable Restore platforms, it records the recoverable version 4 protocol instead. Version 4 can recover an interrupted operation, but an abrupt termination between retirement and publication can temporarily leave the replaced target absent; it does not promise continuous target presence.

Apply and Repair create journal version 5 for atomic file exchange. Doctor and Restore continue to read and recover existing version 4 journals. A pending version 5 journal requires Linux with GNU `mv` supporting `--exchange` and `--no-copy`; Restore reports that prerequisite before changing the managed-root record. Durable journals and managed-root records retain one fixed predecessor and one prepared candidate beside their canonical name. After an interrupted publication or cleanup, Doctor can read the predecessor and the next locked Island command completes its owned recovery. If canonical and predecessor records disagree without the candidate proof that explains the change, Tyrian preserves both generations and reports manual recovery instead of overwriting or deleting either one. Older UUID-named retirement files also remain preserved for manual recovery because their original ownership cannot be proved.

> [!WARNING]
> Before uninstalling Tyrian Night, run **Tyrian Night: Restore Classic UI**, reload VS Code, and confirm that the custom UI is gone. Uninstalling the extension alone cannot remove an active patch.

Commands:

- **Tyrian Night: Apply Island UI**
- **Tyrian Night: Repair Island UI**
- **Tyrian Night: Restore Classic UI**
- **Tyrian Night: Doctor Island UI**

Apply preflights the canonical application root, desired stylesheet, current patch, backup receipts, transaction evidence, checksums, and write access. It then transactionally updates one stylesheet link in `workbench.html`, one CSS file, and the matching `product.json` checksum.

Tyrian stores backups beside the patched files, records the exact physical application root and hashes in a manifest, serializes writers with process locks, and rolls an interrupted file transaction back before another mutation. Restore accepts backups only when the complete receipt proves they belong to the current patch; otherwise it removes Tyrian-owned evidence and repairs the checksum.

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
