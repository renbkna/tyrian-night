# Tyrian Night

A deep, ultra-saturated visual system built on color science and exported across editors, terminals, desktop shell colors, and the installable rice profile. Main editor text and syntax colors are tuned for WCAG AA contrast while quieter UI chrome stays intentionally lower contrast.

![Theme Preview](assets/preview.png)

## Features

- **Single visual source** — `source/themes/` defines Tyrian Abyss, Night, Nocturne, Night Old, and Dawn for every consumer
- **WCAG AA tuned across the family** — Abyss, Night, Nocturne, Night Old, and Dawn keep AAA main text and AA syntax contrast
- **Perceptually distinct core palette** — advertised syntax roles are separated by CIEDE2000 ΔE > 12
- **True dark backgrounds** — Abyss starts at `#030207` and Night at `#0C0C0C`, optimized for OLED and dim environments
- **Full semantic highlighting** — declared natively, no configuration needed
- **Universal language support** — works with any TextMate grammar
- **Built-in Island UI controls** — apply, repair, and restore the workbench patch without `Custom UI Style`

## Repo Layout

This repo defines the Tyrian Night visual identity and exports it everywhere I use a computer.

- `source/themes/` owns theme identity and palette data; `source/themeCatalog.json` owns ordered membership and default roles.
- `apps/vscode/` owns the VS Code extension runtime and Island UI assets.
- `apps/zed/` owns the Zed theme extension.
- `terminal/` owns Ghostty, Foot, fish, Starship, and Fastfetch outputs.
- `desktop/` owns KDE Plasma and Caelestia outputs.
- `rice/` owns the captured portable layout and wallpaper profile.
- `scripts/` owns generators, live install, and rice install logic.
- `assets/` owns shared preview/icon assets.

## VS Code Installation

1. **Extensions** panel → search `Tyrian Night` → **Install**
2. Use the first-run prompt, or **Ctrl+K Ctrl+T** → select **Tyrian Night**
3. If you want Island UI, run `Tyrian Night: Apply Island UI` and accept the restore-before-uninstall warning

> If you use Island UI, read the [uninstall warning](#island-ui) before enabling or removing it.

The source repo includes a [VS Code companion settings example](https://github.com/renbkna/tyrian-night/blob/main/apps/vscode/settings.example.json) for typography, editor chrome, terminal font, file nesting, language formatters, and Tyrian defaults.

## Palette

| Role | Hex | Ratio | Level |
|:-----|:-----|------:|:------|
| Background (Tyrian Canvas) | `#0C0C0C` | — | — |
| Active line (Reading Surface) | `#181820` | — | — |
| Variables (Soft Lilac) | `#D0C8E0` | 12.13:1 | AAA |
| Keywords (Amethyst Purple) | `#8D69C1` | 4.59:1 | AA |
| Types (Deep Cobalt) | `#5A78C0` | 4.55:1 | AA |
| Functions (Soft Crimson) | `#BA5E6B` | 4.57:1 | AA |
| Strings (Emerald) | `#489060` | 5.06:1 | AA |
| Data Literals (Cool Mauve) | `#B58CBA` | 6.92:1 | AA |
| Parameters (Cool Mauve) | `#B58CBA` | 6.92:1 | AA |

UI chrome elements (line numbers, breadcrumbs) use lower contrast (~2.8:1) to reduce visual noise.
`Tyrian Nocturne` is the free redesign built around the active line as the real reading background.
`Tyrian Night Old` is included as a comparison preset with the previous keyword `#8B6ABD` and method `#3A9690` syntax palette.

<details>
<summary><strong>Recommended Typography</strong></summary>

```jsonc
{
  "editor.fontFamily": "'Monaspace Neon var', 'JetBrains Mono', 'IBM Plex Mono', monospace",
  "editor.fontSize": 15,
  "editor.fontWeight": "450",
  "editor.fontVariations": "'wdth' 95, 'slnt' 0, 'GRAD' -50",
  "editor.fontLigatures": "'calt', 'ss01', 'ss02', 'ss03', 'ss04', 'ss05', 'ss06', 'ss07', 'ss08', 'ss09', 'ss10', 'liga', dlig",
  "editor.lineHeight": 1.5,
  "editor.cursorBlinking": "smooth",
  "editor.cursorSmoothCaretAnimation": "on",
  "editor.smoothScrolling": true,
  "terminal.integrated.fontFamily": "'Monaspace Neon var', 'IBM Plex Mono', monospace",
  "terminal.integrated.fontSize": 14,
  "terminal.integrated.lineHeight": 1.4
}
```

Italic syntax is reserved for prose surfaces: comments, doc comments, notes, TODO-style annotations inside comments, and Markdown emphasis or quotes. Deprecated code is strikethrough only. When your editor or terminal can route italic text to a separate face, use `Monaspace Radon` as the italic/comment voice.

</details>

<details>
<summary><strong>Recommended Icon Theme</strong></summary>

```jsonc
{ "workbench.iconTheme": "vs-seti-folder" }
```

</details>

## Island UI

Tyrian Night ships its own Island UI supervisor — no external UI patching extension required.

When a Tyrian theme is active, the extension can install or repair Island UI. Apply records that exact style for the physical VS Code installation, so windows using other color themes do not compete over the app-wide shell. Only `Restore Classic UI` disables it. Apply and repair run through a preflight supervisor first: Tyrian checks the canonical app root, desired style, current patch state, backups, checksum state, and whether the app files are locally writable before it attempts to mutate them.

> [!WARNING]
> If Island UI is active, you must run `Tyrian Night: Restore Classic UI` before uninstalling the extension. Uninstalling Tyrian Night does not remove the custom UI patch.

> [!WARNING]
> Do not click uninstall first. Restore the classic UI, reload VS Code, confirm the patch is gone, and only then uninstall the extension.

The patch surface is intentionally narrow: a single Tyrian stylesheet injected into `workbench.html`, one CSS asset copied into the workbench directory, and a matching `product.json` checksum update. Tyrian-owned backups sit next to patched files for reliable rollback, and a v3 manifest receipt records the app root, desired style, patch strategy, upstream hashes, patched hashes, CSS hash, and owned sidecar names. One shared user-level record per canonical app root owns both the desired style and managed-installation lifecycle. A physical-root lock serializes every writer, while a recoverable mutation journal rolls an interrupted commit back before the next operation. Restore trusts backup sidecars only when the complete manifest receipt matches the current patch and upstream backups; otherwise it removes all Tyrian stylesheet evidence and repairs the checksum. If a VS Code package update resets the app tree or file permissions, Tyrian reports that as a repair state instead of failing with a raw filesystem error.

**Required uninstall steps:**

1. Run `Tyrian Night: Restore Classic UI`.
2. Reload VS Code.
3. Confirm the custom UI is gone.
4. Uninstall the extension.

**Commands:**
`Tyrian Night: Apply Island UI` · `Repair Island UI` · `Restore Classic UI` · `Doctor Island UI`

**Doctor** classifies each managed app root as `clean`, `patched`, `managed-only`, `missing`, `permission-denied`, `broken-backup`, or `checksum-mismatch`, compares the exact desired and installed styles, and reports VS Code version, workbench hashes, writability, restore proof, the last manifest receipt, and the recommended action. Permission-required and blocked roots are reported separately; partial cleanup is never announced as complete.

Package-managed installs must make the VS Code app files writable outside Tyrian before applying or restoring Island UI. Tyrian does not request administrator privileges or change file ownership and permissions. Package updates may reset those files, so re-establish writability with the system package or administration tools before running `Repair Island UI` or `Restore Classic UI`.

Restoring Classic UI removes Tyrian's workbench block, CSS, manifest, and backup sidecars. If the app files are no longer writable, restore stops and Doctor reports the affected roots instead of claiming cleanup succeeded.

> Because Island UI patches `workbench.html`, VS Code may show *"Your installation appears to be corrupt"* while it is active. This is expected and does not indicate broken files.

> Based on [vscode-dark-islands](https://github.com/bwya77/vscode-dark-islands) by [bwya77](https://github.com/bwya77).

## Terminal Companion Configs

Tyrian Night also ships repo-local companion configs for terminal tools:

- `terminal/ghostty/` controls terminal window colors and ANSI palette.
- `terminal/foot/` controls terminal window colors and ANSI palette.
- `terminal/fish/` controls shell syntax and pager colors.
- `terminal/starship/` controls the prompt layout and prompt colors.
- `terminal/fastfetch/` controls the startup system summary.

These assets are generated from `source/themes/` so the Tyrian palette remains the source of truth.

## Desktop Companion Configs

Tyrian also owns desktop rice outputs:

- `desktop/kde/` contains generated KDE color schemes, Tyrian Plasma desktop-theme and look-and-feel packages, and opt-in Union CSS application-style packages.
- `source/union-css/` contains the editable modular Union CSS rice source; the generator injects Tyrian palette tokens and flattens it.
- `desktop/caelestia/` contains generated Caelestia scheme, state, and Hyprland color files.

These files keep Tyrian as the palette and rice source of truth while KDE and Caelestia only provide the runtime that loads the installed files.

For a local machine install, preview the live changes first:

```sh
node scripts/installLiveTyrian.mjs
```

Apply them with:

```sh
node scripts/installLiveTyrian.mjs --apply
```

The default install copies Tyrian-owned assets and generated configs into
`~/.local/share/tyrian-night/`, then writes the live terminal, KDE, and Caelestia config targets to use that installed copy.
The entrypoint prepares ignored generated runtime assets first, so it works from a clean checkout. The apply is filesystem-transactional and restores the exact prior files and directory absence on failure. It does not mutate the current systemd, D-Bus, or Plasma process state; restart affected applications or start a new desktop session after a style-only install. Backups are written under `~/.local/state/tyrian-night/backups/`. After a normal install, the
cloned repo can be moved or deleted. Use `--link` only for local theme development when you want
live app files to follow edits inside the repo:

```sh
node scripts/installLiveTyrian.mjs --apply --link
```

## Tyrian Rice

The rice entrypoint installs the complete Tyrian setup:

- `terminal/ghostty/`, `terminal/foot/`, `terminal/fish/`, `terminal/starship/`, and `terminal/fastfetch/`
- KDE color scheme, Plasma desktop-theme skin, launcher/taskbar surfaces, lock-screen wallpaper, and Caelestia color state
- Plasma panel/widget layout from `rice/plasma-layout/`

The captured Plasma layout expects the widgets listed in
[`rice/plasma-layout/requirements.md`](rice/plasma-layout/requirements.md). Install those first on a
new machine if you want the widget layout to restore cleanly.

Preview the full rice install:

```sh
bun run rice
```

Apply the full rice on a machine:

```sh
bun run rice --apply
```

The default rice install is materialized the same way: `~/.local/share/tyrian-night/`
is the machine-local Tyrian source for terminal, desktop, wallpaper, lock-screen, fastfetch, and layout assets. The
repo remains the editable/generator source of truth; the installed copy is the machine-local
source used by live apps. Use `--link` only when this repo should remain the live source:

```sh
bun run rice --apply --link
```

The Plasma layout restore replaces `~/.config/plasma-org.kde.plasma.desktop-appletsrc` and `~/.config/plasmashellrc`, backs up the previous files under `~/.local/state/tyrian-night/backups/`, injects the current machine's active Plasma activity ID into desktop containments, restarts Plasma shell, and applies the wallpaper to the current desktops through `qdbus6`. One persisted transaction owns the complete style-and-layout generation, including shell, panel, and wallpaper state. A failed operation rolls back the whole generation; the next rice operation recovers an interrupted one before starting new work. The runtime activity and wallpaper steps are intentional because Plasma desktop containments are machine-local while the repo snapshot must stay portable and publishable.

Recapture the current machine layout after deliberate widget or wallpaper changes:

```sh
bun run rice --capture-layout
```

Capture briefly stops an active Plasma shell so its configuration and runtime panel state form one generation, proves the original shell and panel state after restart before publishing, and retains a repository lock plus recovery journal until that proof is complete.

## Contributing

Found a language or scope that needs work? [Open an issue](https://github.com/renbkna/tyrian-night/issues).

## License

[Apache License 2.0](LICENSE) © [renbkna](https://github.com/renbkna)
