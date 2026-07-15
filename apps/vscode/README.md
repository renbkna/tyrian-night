# Tyrian Night for VS Code

Tyrian Night provides five generated VS Code color themes:

- **Night** — neutral-black, quiet, and canonical;
- **Nocturne** — cold-black, mineral, and dangerous;
- **Pastel** — a complete soft dark-dream palette;
- **Abyss** — OLED black with ultraviolet-electric accents;
- **Dawn** — the light counterpart;
- **Night Old** — an unchanged legacy comparison theme.

The projection covers a curated set of documented public VS Code colors for control states, selection and keyboard focus, chat and inline chat, notebooks, testing, terminal symbol icons, gauges, and agent-session indicators. High-contrast-only borders, shadows, and opacity controls intentionally keep VS Code defaults.

## Support

- Color themes and the packaged extension support VS Code 1.118 or newer on Linux, macOS, and Windows.
- Island UI apply and repair support Linux only.
- Doctor and Restore Classic UI remain available on every platform so an installation managed by an older Tyrian version can be inspected and removed.
- Tyrian never requests administrator privileges or changes file ownership or permissions.

The color themes use the normal VS Code extension contract. Merely installing or selecting a theme does not modify the VS Code application.

## Install and select a theme

1. Open the Extensions panel and install **Tyrian Night**.
2. Run **Preferences: Color Theme**.
3. Select a Tyrian theme.

The repository includes a [`settings.example.json`](settings.example.json) companion for typography and editor preferences. It is not applied automatically.

## Island UI

Island UI is an optional Linux-only workbench patch. Apply and Repair refuse unsupported platforms before filesystem or desired-state admission.

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

[Apache License 2.0](../../LICENSE)
