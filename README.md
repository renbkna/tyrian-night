# Tyrian Night

One visual system exported to editor, terminal and Linux desktop products. Neutral theme roles live in `source/`; every consumer file is a generated projection and never feeds back into the palette.

## Products and Support

| Product | Supported systems | Mutation level | Product contract |
|---|---|---:|---|
| VS Code color themes | VS Code 1.118+ on Linux, macOS, and Windows | Standard extension install | [`apps/vscode/README.md`](apps/vscode/README.md) |
| VS Code Island UI | Linux, macOS, Windows | Patches the VS Code application | [`apps/vscode/README.md#island-ui`](apps/vscode/README.md#island-ui) |
| Zed themes | Systems supported by Zed | Standard theme extension | [`apps/zed/README.md`](apps/zed/README.md) |
| Terminal and desktop files | Wherever each target accepts them | Files you link or copy from the checkout | Component README files |

The root `package.json` owns the Bun version (`packageManager`) and the Node.js floor (`engines`); CI reads both.

### Safety Before Apply

- The VS Code and Zed color themes install through the editors' normal extension mechanisms and patch nothing.
- Island UI is a separate, opt-in patch of VS Code's application files; Doctor and the restore-before-uninstall warning are part of its contract.
- Nothing here writes terminal or desktop configuration; you link or copy those files yourself.

## Family

Five expressions of one semantic system, not near-duplicate palettes:

| Theme | Character |
|---|---|
| **Night** | Quiet plum-black: Abyss's grammar at 60% of its saturation, the softest plain text |
| **Nocturne** | The tempered middle step: 80% of Abyss's saturation on plum-black |
| **Pastel** | The pastel model: equally soft light tints on a dusk-plum editor |
| **Abyss** | Default and reference: the deepest editor and the richest matte jewel tones |
| **Dawn** | Daylight: the same grammar, deep and vivid on lavender-tinted paper |

### Color roles

- **Purple** owns identity, focus, control flow and selected emphasis; declaration, modifier and import keywords use a calmer purple.
- Every other category keeps its own color: salmon errors (ANSI red too), amber warnings, peach literals (numbers, booleans, `null`/`nil`/`None`, regular expressions), green strings and success, dusty-blue functions, smoky-indigo structural types, cool-rose data (parameters, keys, attributes, named constants) and blue information. Plain identifiers have their own color, separate from UI text.
- **Green through cyan** is reserved, as brand policy, for strings, success states, hints and ANSI green.
- ANSI names are protocol slots; each theme owns how they render.
- **Brackets** use a dedicated six-depth palette in the quiet syntax tier, so nesting never outranks the code it frames; the safety contract keeps the depths distinct.

## Palette

- **Steps.** Abyss is the semantic base. Night, Nocturne and Abyss share one hue profile: Nocturne takes about 80% and Night about 60% of Abyss's saturation per syntax role, with editor depth and plain-text contrast stepping down alongside. Pastel and Dawn use related branch hue profiles.
- **Solved, not authored.** A recipe sets APCA targets per syntax tier and for plain text, a saturation level and the chroma of its near-neutral pigments; `scripts/syntaxSolver.mjs` derives every syntax and bracket color against the canvas.
- **Matte lightness.** In the three dark variants colored code sits at jewel-tone brightness (APCA Lc about 55 for leads, 49 for supports) while plain text stays bright: bright saturated color on near-black reads as neon.
- **Saturation bands** (`syntaxSaturation`), as a share of the sRGB chroma available at each role's lightness and hue: Abyss 85–90%, Nocturne 66–74%, Night 48–56%, Dawn 75–80%. Pastel caps absolute chroma at 0.10 instead, because sRGB leaves green far more room than blue at pastel lightness.
- **Syntax ladder** (`syntaxHierarchy`, APCA against the canvas): control flow and functions lead; types, data, strings, literals and Markdown emphasis and links support; declaration and import keywords sit below; comments, documentation, punctuation and bracket pairs recede furthest. Symbolic operators belong to punctuation; word operators (`typeof`, `new`, Python's `and`) to declarations.
- **Weight.** Function and type definitions are bold where defined; calls and references keep normal weight in VS Code and Zed.
- **Colorfulness ceilings.** A vivid color reads louder than its contrast suggests, so no support color exceeds 80% of the most colorful lead's chroma, and declarations 75%; the ceiling wins over the saturation band.
- **Diagnostics** (`diagnostics`): errors and warnings interrupt through saturation, using nearly all available chroma; the safety contract keeps them visible as marks.
- **Hard floors.** Code uses APCA (plain text Lc 70, code colors 45, declaration keywords 40, comments and punctuation 30), because WCAG 2 overrates light text on dark backgrounds; UI text, state labels and label/surface pairs keep WCAG 2 minimums. Independent states never render the same color. Role alpha comes from the shared opacity contract.

OKLCH, OKLab distance, color-vision simulation and richness (`rho = C / Cmax(L, h, sRGB)`, which tells a deep pigment from a grayed one at the same lightness and hue) are author diagnostics, not quality scores; a saturation band is an equal share of reachable chroma, not equal perceived colorfulness. Judge the result in real editors with the scenes in [`examples/theme-preview`](examples/theme-preview/README.md): important code reads clearly, comments and punctuation recede without vanishing, errors, search and selection interrupt, and the whole stays comfortable for daily work.

## Interaction Contract

Shared by every product:

- Hover changes the local surface and may add a low-chroma neutral border; pressed uses a stronger active surface; checked or selected uses a persistent low-chroma accent surface.
- Keyboard focus adds an outline without replacing hover, press, selection or validation state.
- Saturated accent is reserved for keyboard focus, primary actions, progress and compact indicators; destructive actions keep semantic red.
- Small radii for indicators, medium for controls and rows, large for cards, dialogs and popups.
- The editor is the lit stage: activity bar, title and status bars, side bar, panel and tab strip are never lighter than it. Pastel and Dawn frame it darker; the near-black variants keep the frame flat and separate panels with borders. The active tab and breadcrumbs share the editor surface, Island UI uses the darkest frame color as its backdrop, and popups, inputs and hover states sit above the editor.

The VS Code projection maps these states explicitly (toolbar actions, checkboxes, radios, input options, action bar, status bar, command center, chat, notebooks, tests, agent UI) and leaves high-contrast-only defaults such as `contrastBorder` unset.

## Editor Installation

Install **Tyrian Night** from the VS Code Extensions panel and pick a variant with **Preferences: Color Theme** (Tyrian Abyss is the default). The one extension also carries the opt-in Island UI.

For Zed, install the extension from `apps/zed/` or follow its product README.

## Terminal and Desktop Files

See [Ghostty](terminal/ghostty/README.md), [foot](terminal/foot/README.md), [fish](terminal/fish/README.md), [Starship](terminal/starship/README.md), [KDE Plasma](desktop/kde/README.md), [Caelestia](desktop/caelestia/README.md) and [DMS](desktop/dms/README.md). Linked files follow the checkout, so `git pull` updates them.

## Authority and Repository Layout

- `source/*.cjs` are typed data modules: `bun run check` rejects shape errors and unknown fields; loaders validate only cross-file references and value ranges.
- `source/themeRoleContract.cjs`: role membership.
- `source/themeCatalog.cjs`: ordered family membership, per-appearance terminal defaults, each theme's Island effect profile.
- `source/islandEffects.cjs`: hand-tuned Island effect profiles (shadows, borders, glow opacity); colors come from roles.
- `source/themeColorBindings.cjs`: role aliases and alpha derivations; unlisted roles own one opaque pigment.
- `source/themeOpacityContract.cjs`: the family opacity policy, with appearance-only overrides.
- `source/themeFamilyContract.cjs`: the default theme, pigment vocabulary, hue profiles, appearance classes, syntax tiers with contrast steps and colorfulness ceilings, saturation bands, branch hue limits.
- `source/themePigmentPolicy.cjs`: the green-through-cyan reservation.
- `source/themes/`: each variant's OKLCH lightness and chroma for UI, terminal and status pigments, plus its syntax targets.
- `source/themeSafetyContract.cjs`: hard contrast and state-identity requirements for every catalog theme.
- `scripts/colorScience.mjs`: policy-free sRGB, contrast, OKLab/OKLCH, distance and richness math.
- `scripts/projections/`: consumer-specific key and grammar mappings.
- `scripts/generate.mjs`: the generator registry (`bun run generate`; `--check`, `--product`, `--tracked`, `--untracked`).
- `source/union-css/`: reusable component geometry and interaction rules.
- `examples/theme-preview/`: the real-editor inspection corpus and a generated workbench; guidance, not a scored gate.
- `apps/vscode/` and `apps/zed/`: the editor products.
- `terminal/` and `desktop/`: generated assets, committed for use from a checkout; `bun run verify` fails when they are stale.

Island code: `islandShell.ts` orchestrates commands, `islandPatchPlan.ts` derives the ordered file changes and checks patch invariants, `islandFileSystem.ts` writes them atomically, `islandRegistry.ts` owns desired state, discovery and quarantine, and `islandLock.ts` gives every mutating command one per-user OS lock. Each command records its intent, then converges the files, so rerunning an interrupted one completes it. Startup reconciliation and Repair run as the single `converge` command, reading and acting on the saved style under that lock.

## Development

```sh
bun install --frozen-lockfile
bun run color:audit
bun run color:audit -- --theme=tyrian-nocturne --diagnostics
bun run verify
bun run package:vscode
```

`color:audit` reports accessibility and brand-policy failures separately; `--diagnostics` adds contrast, OKLCH, richness and state distances without scoring them.

CI packages the VS Code product and runs the shipped Island CLI on Linux, macOS and Windows; Linux also runs the full gate. The fish tests need `fish` on `PATH`.

## Contributing

Found a language, scope, or component state that needs work? [Open an issue](https://github.com/renbkna/tyrian-night/issues).

## License

[Apache License 2.0](LICENSE) © [renbkna](https://github.com/renbkna)
