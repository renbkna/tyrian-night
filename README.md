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
| **Tyrian Nocturne** | Cold-black, gothic, and dangerous | Cobalt structure, hard-indigo types, dried-blood data, the sole moss-green string pigment, and carved low-energy depth |
| **Tyrian Pastel** | Soft dark dream | Periwinkle, sea-glass, dusty rose, mint, apricot, and lavender across every colored role |
| **Tyrian Abyss** | Near-OLED and electric | Maximum contrast and chroma without collapsing semantic hues into purple |
| **Tyrian Dawn** | Soft light and ink-dark | Light counterpart with the same categorical syntax and state behavior |
| **Tyrian Night Old** | Legacy comparison | Exact previous palette, kept last in the catalog and excluded from new family constraints |

Purple owns identity, focus, keywords, and selected emphasis. It does not replace salmon errors, amber warnings and regular expressions, the controlled green string pigment, deep-blue functions, cool structural types, cool-rose data, or blue information. Terminal ANSI names remain protocol slots; each theme owns their rendered material.

Bracket nesting uses a dedicated six-depth palette rather than borrowing syntax or UI accents. Its APCA band stays narrowly above Zed's renderer guard, while low OKLCH chroma and minimum OKLab separation keep depths distinguishable without turning punctuation into the dominant layer.

## Palette

Tyrian Night is authored as exact sRGB pigments and role-owned opacities. The family contract evaluates those values with WCAG contrast, APCA prominence, OKLab separation, OKLCH material envelopes, complete dichromacy simulations, and witnessed code neighborhoods compiled from semantic specimens. Primary text is AAA; core syntax, statuses, and ANSI colors are AA or stronger against the editor canvas.

Authority is deliberately asymmetric. Product meaning and atmosphere live in this repository. Source recipes own exact colors; the binding contract owns which roles share a pigment; the appearance contract owns hierarchy and visual constraints; the forge contract owns the advisory search envelope; hashed semantic specimens own reviewed code evidence from which exposure and co-occurrence are derived. APCA, OKLab, OKLCH, HCT, and CVD simulation are measurements or proposal mechanisms, never competing palette authorities. Material Color Utilities seeds bounded HCT candidates and harmony tie-breaks, but it cannot redefine Tyrian semantics. Generated consumers receive the resolved source colors exactly.

| Role | Hex | Ratio | Level |
|:-----|:-----|------:|:------|
| Background (Neutral Canvas) | `#0F0E13` | — | — |
| Active line / Hover Surface | `#2A2633` | — | — |
| Variables (Soft Lilac) | `#AFA9B9` | 8.42:1 | AAA |
| Keywords (Tyrian Violet) | `#8F70BE` | 4.79:1 | AA |
| Types (Cool Cyan) | `#408F99` | 5.13:1 | AA |
| Functions (Blue) | `#7193C2` | 6.09:1 | AA |
| Strings (Calm Green) | `#57885B` | 4.65:1 | AA |
| Data / Receivers (Cool Rose) | `#AA738C` | 5.07:1 | AA |
| Regular Expressions (Amber) | `#9A7B38` | 4.82:1 | AA |

Blue functions and salmon errors remain perceptually separate across the current family. Cool-rose data stays distinct from errors, cool structural types retain their category, and ANSI red retains the error category.

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
- `source/themeColorBindings.json` owns explicit role aliases and alpha derivations; unlisted roles self-own one opaque pigment.
- `source/themes/` owns each variant's exact pigments and opacities; current themes and the frozen legacy theme use explicit binding profiles.
- `source/themeAppearanceContract.json` owns family hierarchy, hue language, variant material, accessibility, CVD, and renderer constraints.
- `source/themeForgeContract.json` owns forge admission, candidate bounds, harmony reference, and deterministic search limits; it cannot define visual semantics.
- `source/themeSpecimens.json` owns versioned code specimens, complete semantic spans, source hashes, and required language/context/interaction coverage; the forge derives exposure and neighborhoods and fingerprints the annotations and sampling policy.
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
bun run color:audit -- --theme tyrian-night --roles syntax:regexp,syntax:string --move separate
bun run verify
bun run package:vscode
```

The color forge is read-only and admits only themes selected by its forge contract and roles required by its reviewed specimen set; the frozen legacy profile cannot be retuned. It resolves requested roles to their pigment owners, derives exposure and a witnessed interaction graph from the selected specimen corpus, generates bounded HCT candidates, and searches interacting assignments with a pinned deterministic beam. The default move maximizes normal/CVD neighborhood separation while the appearance contract preserves semantic prominence; explicit `promote`, `quiet`, `warmer`, and `cooler` moves remain available. Contract-invalid states may be explored only inside the bounded search and are never returned as recommendations. Reports carry appearance, forge, role, binding, source, and corpus hashes plus dependency, candidate-lineage, coverage, and search provenance, and claim only the best contract-valid result found inside that declared envelope. If the bounded search finds no valid result, it reports that outcome explicitly and exits unsuccessfully. Accepted pigments remain explicit source-theme edits.

CI packages the static VS Code product on Linux, macOS, and Windows. Linux additionally runs the Island mutation proofs and desktop installer proofs.

## Contributing

Found a language, scope, or component state that needs work? [Open an issue](https://github.com/renbkna/tyrian-night/issues).

## License

[Apache License 2.0](LICENSE) © [renbkna](https://github.com/renbkna)
