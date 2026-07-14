# Tyrian Night

Tyrian Night is one visual system exported to several independently supported products. Neutral theme roles live in `source/`; editor, terminal, KDE, and Caelestia files are generated projections.

## Products and Support

| Product | Supported systems | Mutation level | Product contract |
|---|---|---:|---|
| VS Code color themes | VS Code 1.118+ on Linux, macOS, and Windows | Standard extension install | [`apps/vscode/README.md`](apps/vscode/README.md) |
| VS Code Island UI | Linux only | Patches the VS Code application | [`apps/vscode/README.md#island-ui`](apps/vscode/README.md#island-ui) |
| Zed themes | Systems supported by Zed | Standard theme extension | [`apps/zed/README.md`](apps/zed/README.md) |
| Terminal and desktop files | Manual use wherever the target application supports them | User-selected files | Component README files |
| Live desktop installer | Linux with `/proc` and GNU `mv --exchange` | Replaces user configuration transactionally | [`apps/desktop/README.md`](apps/desktop/README.md) |
| Full rice installer | Linux, KDE Plasma 6, and the declared commands/widgets | Replaces Plasma layout and restarts Plasma | [`apps/desktop/README.md#full-rice`](apps/desktop/README.md#full-rice) |

The repository workspace requires Bun 1.3.11 and Node.js 22.19 or newer. Product manifests own narrower runtime requirements.

## Editor Installation

For VS Code, install **Tyrian Night** from the Extensions panel and select a theme with **Preferences: Color Theme**. Island UI is a separate opt-in Linux feature; installing a color theme does not patch VS Code.

For Zed, install the theme extension from `apps/zed/` or follow its [product README](apps/zed/README.md).

## Desktop Commands

Desktop preview commands are observational: they read repository and destination state, print the plan, and do not generate files, acquire mutation locks, or recover interrupted transactions.

```sh
# Preview or apply the terminal + KDE Plasma 6 profile.
bun run desktop:plasma:preview
bun run desktop:plasma:apply

# Preview or apply the terminal + Caelestia/Hyprland profile.
bun run desktop:caelestia:preview
bun run desktop:caelestia:apply

# Explicitly recover an interrupted style transaction.
bun run desktop:recover

# Preview the complete style and Plasma layout rice.
bun run rice

# Apply or recover the complete rice.
bun run rice:apply
bun run rice:recover
```

Read the [desktop product contract](apps/desktop/README.md) before applying it. The full rice is not a generic theme installer.

## Palette

Tyrian Night’s default palette is generated from neutral roles. Main text is tuned for AAA contrast and syntax roles for AA contrast; quieter UI chrome is intentionally lower contrast. Syntax separation is audited with OKLab distance plus pair-specific hue and lightness guards.

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

The family contains Tyrian Abyss, Night, Nocturne, Night Old, and Dawn. Italic syntax is reserved for prose surfaces such as comments and Markdown emphasis; deprecated code is strikethrough only.

## Authority and Repository Layout

- `source/themeRoleContract.json` owns role membership.
- `source/themeCatalog.json` owns ordered theme membership and defaults.
- `source/themes/` owns neutral UI, syntax, effect, and ANSI values.
- `scripts/projections/` owns consumer-specific key mappings.
- `apps/vscode/` owns the VS Code manifest, build, runtime, package contents, and support contract.
- `apps/zed/` owns the Zed extension.
- `apps/desktop/` owns the Linux installer version, commands, and support contract.
- `terminal/`, `desktop/`, and `rice/` contain generated or captured product assets.
- The root `package.json` is private workspace orchestration; it is not a publishable extension manifest.

Generated consumers never become palette inputs.

## Development

```sh
bun install --frozen-lockfile
bun run verify
bun run package:vscode
```

CI packages the static VS Code product on Linux, macOS, and Windows. Linux additionally runs the Island mutation proofs and desktop installer proofs.

## Contributing

Found a language or scope that needs work? [Open an issue](https://github.com/renbkna/tyrian-night/issues).

## License

[Apache License 2.0](LICENSE) © [renbkna](https://github.com/renbkna)
