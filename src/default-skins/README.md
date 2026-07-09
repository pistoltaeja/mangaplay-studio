# Skin Author Contract

This directory holds the two first-party Mangaplay Studio skins
(`default/`, `night/`) and the skin-independent `root.css` token file.
It is also the authoring reference for the future in-app skin
marketplace: a third-party skin drops into `<user-data-dir>/user-skins/<id>/`
using the same layout enforced here.

## Layout

```
default-skins/
    root.css                  ← skin-independent :root tokens (fonts,
                                splash chrome dimensions, layout
                                constants). Loaded ONCE by index.html
                                BEFORE the active-skin link — never
                                overridden by a skin.
    <skin-id>/
        <skin-id>.css         ← palette CSS, scoped :root[data-skin="<id>"]
        skin.json             ← manifest (see schema below)
        mascot-<skin-id>.png  ← picker + help modal mascot
        splash-<skin-id>.png  ← 320×? boot splash
        splash-<skin-id>@2x.png (optional, 640×? HiDPI)
```

**Forbidden files.** Skin bundles are CSS + JSON + images only. `.js`,
`.html`, `.wasm` are rejected by `validateManifest()` in
[`boot/skins.js`](../js/boot/skins.js) AND by the build-time copy walker in
[`scripts/copy-assets.js`](../../scripts/copy-assets.js). The trust
boundary is deliberately CSS-only — Discord and Slack learned this the
hard way.

## `skin.json` schema

```json
{
    "id":            "night",                    // required, lowercase
                                                 //   alphanumeric + dashes,
                                                 //   <= 64 chars, unique
    "displayName":   "Night",                    // required, <= 64 chars
    "author":        "Mangaplay Studio",         // required
    "version":       "1.0.0",                    // required, semver
    "baseVariant":   "dark",                     // required, "light" | "dark"
    "cssFile":       "night.css",                // required, relative path
                                                 //   inside the skin folder
    "mascotHeadFile": "mascot-head-night.png",   // required
    "mascotBodyFile": "mascot-body-night.png",   // required
    "splashFile":    "splash-night.png",         // required
    "splashFile2x":  "splash-night@2x.png",      // optional
    "minAppVersion": "0.0.0",                    // required, semver
    "license":       "CC BY-NC-SA 4.0"           // optional, marketplace
                                                 //   display slot
}
```

### `baseVariant`

VS Code's `uiTheme` pattern. Tells the app which fallback to use for
surfaces the skin's CSS doesn't override (currently: the CM6 editor's
built-in dark toggle). Marketplace filtering may also key off this
field. It is a hint, not a constraint — a `baseVariant: "dark"` skin
that ships its own light CSS won't be blocked.

### `license`

Marketplace-display slot. Not enforced in v1 code but pre-reserved so
future submissions can be labelled accurately.

## CSS restrictions

- **Scope every `:root` declaration under `:root[data-skin="<id>"]`.**
  Bare `:root` selectors would apply globally the moment the CSS is
  fetched — breaks the marketplace's gallery-preview mode where more
  than one skin's CSS may be loaded at once.
- **No `@import`.** Exfiltration vector. `validateManifest()` doesn't
  parse the CSS itself, but the runtime CSP blocks cross-origin fetches
  and marketplace validators will lint on submit.
- **`url()` must resolve inside the skin's own folder.** The marketplace
  will reject `url(https://…)` and `url(../…)` at submission time.

## Asset constraints

- `mascot-<id>.png`: match the source `master-foreground.png` dimensions
  (verify before publishing — this document does not pin an exact size
  because the source may change).
- `splash-<id>.png`: match the source `splash.png` dimensions.
- `splash-<id>@2x.png` (optional): exactly 2× the 1x dimensions.

## What skins do NOT own

- Editor styling (CodeMirror 6 baseTheme). Skins CAN ship
  `.cm-content { … }` rules if they choose to; the app ships no
  fallback beyond the Default skin's CM6 baseTheme + the skin's
  `baseVariant` hint.
- The native OS splash background (Windows / Android). Read from the
  Default skin's `--mps-splash-bg` at build time via
  `scripts/copy-assets.js`. Non-Default skins accept a one-frame
  native-splash mismatch until the WebView paints.
- Fonts. Locale-specific font shards live in `css/fonts-*.css` and load
  through `font-loader.js`. Skins wanting a custom font ship a rule
  like `body { font-family: "Custom", var(--mps-font-app); }` and rely
  on the WebView's local-fonts allow-list.

## Validation errors

`validateManifest()` returns an array of error strings — empty means
valid. Callers are expected to throw on any non-empty result. Common
failures:

| Error message                                       | Fix |
|-----------------------------------------------------|-----|
| `missing or empty string field: <name>`             | Every required field is a non-empty string. |
| `id must be lowercase alphanumeric + dashes`        | `example`, `example-2`, not `Example`. |
| `baseVariant must be 'light' or 'dark'`             | Nothing else is accepted. |
| `version must be semver (e.g. 1.0.0)`               | Same for `minAppVersion`. |
| `<field> has forbidden extension`                   | Only .css / .json / .png / .webp / .jpg allowed. |
| `<field> must be a relative path inside the skin folder` | No `..`, no `\`, no leading `/`. |
