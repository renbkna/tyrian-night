# Tyrian Night

Tyrian Night is one visual system exported to independently supported editor, terminal, and Linux desktop products. Neutral theme roles live in `source/`; consumer files are generated projections.

## Products and Support

| Product | Supported systems | Mutation level | Product contract |
|---|---|---:|---|
| VS Code color themes | VS Code 1.118+ on Linux, macOS, and Windows | Standard extension install | [`apps/vscode/README.md`](apps/vscode/README.md) |
| VS Code Island UI | Linux only | Patches the VS Code application | [`apps/vscode/README.md#island-ui`](apps/vscode/README.md#island-ui) |
| Zed themes | Systems supported by Zed | Standard theme extension | [`apps/zed/README.md`](apps/zed/README.md) |
| Terminal and desktop files | Wherever each target accepts them | User-selected files | Component README files |
| Live desktop installer | Linux with `/proc` and GNU `mv --exchange` | Replaces user configuration transactionally | [`apps/desktop/README.md`](apps/desktop/README.md) |
| Full rice installer | Linux, KDE Plasma 6, and declared commands/widgets | Replaces Plasma layout and restarts Plasma | [`apps/desktop/README.md#full-rice`](apps/desktop/README.md#full-rice) |

The workspace requires Bun 1.3.11 and Node.js 22.19 or newer. Product manifests own narrower runtime requirements.

## Family

The variants are intentionally different expressions of the same semantic system rather than five near-duplicate palettes.

| Theme | Visual center | Purpose |
|---|---|---|
| **Tyrian Night** | Neutral-black and quiet | Canonical daily theme; restrained chrome, readable hierarchy, perceptible surfaces |
| **Tyrian Nocturne** | Visibly purple and atmospheric | The same role grammar with purple-tinted depth and tonal controls |
| **Tyrian Abyss** | Near-OLED and electric | Maximum contrast and chroma without collapsing semantic hues into purple |
| **Tyrian Dawn** | Soft light and ink-dark | Light counterpart with the same categorical syntax and state behavior |
| **Tyrian Night Old** | Legacy comparison | Exact previous palette, kept last in the catalog and excluded from new family constraints |

Purple owns identity, focus, keywords, and selected emphasis. It does not replace red errors, amber warnings and regular expressions, green strings and success, teal functions and ANSI cyan, or blue types and information.

## Palette

Tyrian Night is authored and audited perceptually with OKLab distance and OKLCH coordinates, then stored as portable hexadecimal source values. Primary text is AAA; core syntax, statuses, and ANSI colors are AA or stronger against the editor canvas.

| Role | Hex | Ratio | Level |
|:-----|:-----|------:|:------|
| Background (Neutral Canvas) | `#0A0A0C` | — | — |
| Active line / Hover Surface | `#262330` | — | — |
| Variables (Soft Lilac) | `#CDC7D9` | 12.03:1 | AAA |
| Keywords (Tyrian Violet) | `#A17ADF` | 6.00:1 | AA |
| Types (Clear Cobalt) | `#78A5EF` | 7.94:1 | AAA |
| Functions (Controlled Teal) | `#50A9B1` | 7.21:1 | AAA |
| Strings (Calm Green) | `#649C66` | 6.11:1 | AA |
| Data Literals (Cool Rose) | `#D988B9` | 7.70:1 | AAA |
| Regular Expressions (Amber) | `#C1A057` | 7.94:1 | AAA |

Function teal and error red are separated by more than 20 units of OKLab distance in every current family member. ANSI red and cyan preserve the same categorical distinction.

## Interaction Contract

The component and workbench state language is shared across products:

- Hover changes the local surface and may add a low-chroma neutral border.
- Pressed uses a stronger active surface.
- Checked or selected uses a persistent low-chroma accent surface.
- Keyboard focus adds an outline without replacing hover, press, selection, or validation state.
- Saturated accent is reserved for keyboard focus, primary actions, progress, and compact indicators; destructive actions retain semantic red.
- Small radii belong to indicators, medium radii to controls and rows, and large radii to cards, dialogs, and popups.

The VS Code projection maps these states explicitly for toolbar actions, checkboxes, radios, input options, the action bar, status-bar items, command center, chat, notebooks, tests, and current agent UI. High-contrast-only defaults such as `contrastBorder` remain unset so normal themes do not acquire duplicate outlines.

## Editor Installation

Install **Tyrian Night** from the VS Code Extensions panel, then select a variant with **Preferences: Color Theme**. Island UI is a separate opt-in Linux feature; installing a color theme does not patch VS Code.

For Zed, install the extension from `apps/zed/` or follow its product README.

## Desktop Commands

Desktop preview commands are observational: they read repository and destination state, print the plan, and do not generate files, acquire mutation locks, or recover interrupted transactions.

```sh
bun run desktop:plasma:preview
bun run desktop:plasma:apply

bun run desktop:caelestia:preview
bun run desktop:caelestia:apply

bun run desktop:recover
bun run rice
bun run rice:apply
bun run rice:recover
```

Read the desktop product contract before applying it. The full rice is not a generic theme installer.

## Authority and Repository Layout

- `source/themeRoleContract.json` owns role membership.
- `source/themeCatalog.json` owns ordered family membership and defaults.
- `source/themes/` owns neutral UI, syntax, state, and ANSI values.
- `source/union-css/` owns reusable component geometry and interaction rules.
- `scripts/projections/` owns consumer-specific key and grammar mappings.
- `apps/vscode/` owns the VS Code manifest, build, runtime, package contents, and support contract.
- `apps/zed/` owns the Zed extension.
- `apps/desktop/` owns the Linux installer version, commands, and support contract.
- `terminal/`, `desktop/`, and `rice/` contain generated or captured product assets.

Generated consumers never become palette inputs.

## Development

```sh
bun install --frozen-lockfile
bun run color:audit
bun run verify
bun run package:vscode
```

CI packages the static VS Code product on Linux, macOS, and Windows. Linux additionally runs the Island mutation proofs and desktop installer proofs.

## Contributing

Found a language, scope, or component state that needs work? [Open an issue](https://github.com/renbkna/tyrian-night/issues).

## License

[Apache License 2.0](LICENSE) © [renbkna](https://github.com/renbkna)
