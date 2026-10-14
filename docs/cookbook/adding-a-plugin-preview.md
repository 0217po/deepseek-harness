# Cookbook: Add a built-in plugin feature preview

English | [中文](adding-a-plugin-preview.zh.md)

Use this guide for an optional bundle shipped with the application, including experimental built-ins. The package must already be part of the installation and its optional-bundle list. Third-party packages and on-demand catalog providers do not support previews. The result is one optional image below the plugin description, available before activation.

## 1. Decide whether an image helps

Show one concrete capability or recognizable result, such as an attributed document, a changed interface, or a simple operation. Omit `preview` when the description is enough. Do not add a placeholder or use a large logo as a feature explanation. Keep essential instructions in localized text or configuration outside the image.

## 2. Draw one fixed-size SVG

Only the following format is supported. `verify-package-meta` rejects other formats, incorrect SVG dimensions, and incomplete language declarations. Composition and visual quality still need review in the real page.

| Item | Requirement |
|---|---|
| Count | Zero or one logical feature image per bundle. English and Chinese SVGs are alternatives for that image, not a gallery or carousel. |
| Format and canvas | SVG only, with `width="640" height="300" viewBox="0 0 640 300"`. PNG/JPEG/WebP files, other dimensions, arrays, and standalone preview exports are unsupported. |
| Languages | Every declared preview includes both `en` and `zh`. Translate headings, annotations, and example content; keep official brand assets and product names. |
| Composition | One main example, optionally with one close-up. Keep important content about 32 canvas units from the edge; decorative background or paper may bleed. |
| Text | Short and readable at actual display size, with restrained weights. Outline all lettering as paths; adjust English and Chinese layouts separately. |
| Brand assets | Preserve official logos and actual plugin-produced assets. Their scale and placement may change; their artwork, colors, and words may not. |
| Frame and theme | The page supplies the outer border, radius, and spacing. Keep management controls outside the illustration, and check both light and dark backgrounds. |

The SVG is self-contained: no fonts, remote resources, scripts, handlers, animation, stylesheets, `text`, or `foreignObject`. An `image` element inside the SVG may embed an unchanged official raster asset using a PNG/JPEG/WebP base64 data URL; icons remain geometry-only. This allowance preserves existing brand artwork and does not make raster files valid previews. The gate checks this data-URL envelope, not decoded pixels, and the page renders SVG through `<img>`. Both raw language files together must stay within 1 MiB; that is a ceiling, not a target.

The [badge bundle](../../packages/experimental/badge-skill-bundle/README.md) demonstrates a document and badge close-up. The [voice-input bundle](../../packages/experimental/voice-input-bundle/README.md) demonstrates speech becoming text. Other features do not need the same palette, composition, or title font.

## 3. Declare and publish both language files

Add `preview` to the exported package manifest and include both files in `files`, keeping the package’s existing exports and publication entries:

```json
{
  "preview": {
    "en": "./preview.svg",
    "zh": "./preview.zh.svg"
  },
  "files": ["preview.svg", "preview.zh.svg"]
}
```

Use exactly the `en` and `zh` language keys. A single path, missing language, additional language, or file array is rejected. Paths are relative to the declaring manifest and stay within its directory after symlinks resolve; URLs and absolute paths are rejected. Both files must be published. See [plugin display metadata](adding-a-package.md#plugin-display-metadata) for the manifest export and diagnostics.

## 4. Check the real detail page

Open the built-in bundle from Plugins. The [detail component](../../packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx) and its [styles](../../packages/client/ui-plugin-manager/src/client/PluginManagerPage.module.css) provide these rules:

| Item | Page behavior |
|---|---|
| Position | Below the description, above the components, aligned to the description’s left edge. |
| Spacing | 24 px above the image, 32 px before the following detail sections. These margins are not part of the SVG. |
| Display | Preserve the 640:300 aspect ratio, fit the available width, and cap height at 320 px with `object-fit: contain`. No cropping or stretching; narrow windows scale the fixed source canvas. |
| Border | Semantic border color and the large radius token, `--dsw-radius-lg` (currently 16 px). |
| Loading | Only a viewed installation-owned optional bundle requests its artwork through the resource channel. Lists, component rows, and Settings carry no preview data. |
| Optional and failed states | No declaration means no image or reserved space. Read and decode failures leave enablement and configuration usable. Cards and component rows keep their icons. |
| Language and accessibility | UI language selects the English or Chinese SVG. The image has a localized accessible name derived from the plugin title; essential guidance also remains outside the image. |

## 5. Validate before submitting the PR

1. Run `pnpm run verify-package-meta`, `pnpm run constraints`, and `pnpm run verify-official-bundle-catalog` at the repository root. Fix invalid format, dimensions, language keys, publication entries, and resource diagnostics. The first gate checks both SVGs independently.
2. Build the real application with `pnpm run build && pnpm run build:web`. Check details before and after enablement, English and Chinese, desktop and 390 px windows, and light and dark themes. Confirm decoding, placement, scale, and readable artwork; restore temporary display settings.
3. Check a built-in without artwork and a third-party bundle: neither shows an image. Run the relevant metadata and UI regressions under the [testing policy](../testing.md); malformed or missing artwork never blocks management.
4. Follow [official artwork review](../../.agents/skills/dsh-official-plugin-artwork/SKILL.md) and [record-browser-gif](../../.agents/skills/record-browser-gif/SKILL.md). Attach a real-page GIF for each language, recorded from the PR’s final commit. If the image depicts generated output, demonstrate the plugin’s actual output too.
