# Tyrian Night

A deep, ultra-saturated dark theme built on color science. Maximum depth and saturation within WCAG AA compliance.

![Theme Preview](public/preview.png)

## Features

- **WCAG AA compliant** — 12:1 main text contrast (AAA), 4.5–7:1 for all syntax tokens
- **Perceptually distinct colors** — every syntax category separated by CIEDE2000 ΔE > 12
- **True dark background** — `#0C0C0C` canvas, optimized for OLED and dim environments
- **Full semantic highlighting** — declared natively in the theme, no configuration needed
- **Universal language support** — Works with any language using TextMate grammars (JavaScript, Python, Rust, Go, etc.)
- **Self-managed Island UI layout** — Tyrian Night installs, repairs, and removes its own workbench patch without `Custom UI Style`

## Installation

1. **Extensions** panel → search `Tyrian Night` → **Install**
2. Use the first-run prompt, or run **Ctrl+K Ctrl+T** and select **Tyrian Night**

## Island UI Layout

Tyrian Night now ships with its own Island UI installer. No external UI patching extension is required.

Behavior:

- When **Tyrian Night** is the active color theme, the extension installs or repairs Island UI automatically
- When you switch away from **Tyrian Night**, the extension restores the stock VS Code shell
- On uninstall, Tyrian Night removes its own patch automatically

The patch surface is intentionally narrow:

- It injects a single Tyrian stylesheet into `workbench.html`
- It copies one CSS asset into the workbench directory
- It updates only the matching `product.json` checksum entry
- It keeps Tyrian-owned backups next to the patched files for reliable rollback

Commands:

- `Tyrian Night: Enable Island UI`
- `Tyrian Night: Repair Island UI`
- `Tyrian Night: Restore Classic UI`

> Based on [vscode-dark-islands](https://github.com/bwya77/vscode-dark-islands) by [bwya77](https://github.com/bwya77).

## Palette

| Role | Color | Hex |
|:-----|:------|:----|
| Background | Tyrian Canvas | `#0C0C0C` |
| Variables | Soft Lilac | `#D0C8E0` |
| Keywords | Amethyst Purple | `#8B6ABD` |
| Types | Deep Cobalt | `#5A78C0` |
| Functions | Bioluminescent Teal | `#3A9690` |
| Strings | Emerald | `#489060` |
| Numbers | Sovereign Gold | `#C09040` |
| Parameters | Orchid Pink | `#B068A0` |

## Contrast Ratios

| Token | Foreground | Ratio | Level |
|:------|:-----------|------:|:------|
| Main text | `#D0C8E0` | 12.13:1 | AAA |
| Keywords | `#8B6ABD` | 4.56:1 | AA |
| Types | `#5A78C0` | 4.55:1 | AA |
| Functions | `#3A9690` | 5.54:1 | AA |
| Strings | `#489060` | 5.06:1 | AA |
| Numbers | `#C09040` | 6.80:1 | AA |

UI chrome elements (line numbers, breadcrumbs) use lower contrast (~2.8:1) to reduce visual noise.

<details>
<summary><strong>Recommended Typography</strong> (optional settings)</summary>

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
  // Terminal
  "terminal.integrated.fontFamily": "'Monaspace Neon var', 'IBM Plex Mono', monospace",
  "terminal.integrated.fontSize": 14,
  "terminal.integrated.lineHeight": 1.4
}
```

</details>

<details>
<summary><strong>Recommended Icon Theme</strong> (optional)</summary>

```jsonc
{
  "workbench.iconTheme": "vs-seti-folder"
}
```

The Seti icon theme complements the dark aesthetic with clean, recognizable file icons.

</details>

## Contributing

Found a language or scope that needs work? [Open an issue](https://github.com/renbkna/tyrian-night/issues).

## License

[Apache License 2.0](LICENSE) © [renbkna](https://github.com/renbkna)
