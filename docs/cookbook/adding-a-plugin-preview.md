# Cookbook: adding a built-in plugin feature preview

English | [中文](adding-a-plugin-preview.zh.md)

Use this guide when an official built-in or experimental plugin benefits from a visual explanation of its output. Start with a working bundle and its exported package manifest. The result is an optional image in Plugin Manager that users can understand before enabling the bundle.

## 1. Decide whether a picture helps

Show one concrete capability or recognizable result: a document with attribution, a changed interface, or a concise operation diagram. Leave `preview` absent when the description is sufficient. Do not add an image just to fill space, and do not use a logo enlarged into a banner as the feature explanation. Keep essential usage information in the localized description or configuration UI.

## 2. Compose the artwork

The following conventions apply to official artwork. They guide authoring and review; the metadata validator checks resources and file limits, not composition or aspect ratio. Review a departure from the design canvas with the product designer, together with its real-page rendering.

| Item | Convention |
|---|---|
| Quantity | Zero or one visible feature image per bundle. Language variants are alternatives for that image, not additional slides. No gallery or carousel. |
| Design canvas | Use a 640 × 300 landscape canvas (32:15) by default. Give SVG that intrinsic size and `viewBox="0 0 640 300"`. A raster export may use the same ratio at 1× or 2× resolution. |
| Composition | Use one main example; an enlarged detail is optional. Keep essential content about 32 canvas units from the edges. Decorative paper or background shapes may bleed. |
| Text | Keep wording short and readable at the actual page size. Use clear hierarchy and restrained weight. Secondary labels must not carry the only explanation of the feature. Re-layout English and Chinese rather than squeezing a translation into the original width. |
| Brand assets | Preserve official marks and the plugin's produced assets. A feature preview may arrange or magnify them, but must not redraw, recolor, or change their wording. |
| Page framing | Let the page supply its border, rounded corners, and spacing. Do not draw plugin enable switches, installation buttons, or the surrounding management page into the illustration. |
| Themes | Check the image against both light and dark page backgrounds. One self-contained image serves both; this metadata does not select images by theme. |

Prefer self-contained SVG for diagrams and UI illustrations; use optimized PNG, JPEG, or WebP for screenshots or photographic content. Outline SVG lettering. Do not include fonts, remote images, scripts, event handlers, animation, stylesheets, or `foreignObject`. The combined raw size of all language variants must stay within 1 MiB; this is the accepted maximum, not a target size.

The [badge skill bundle](../../packages/experimental/badge-skill-bundle/README.md) is a complete example: one document illustration with a badge detail, in two languages. Its particular colors, paper composition, and title font are not requirements for other plugins.

## 3. Declare and publish the images

Add `preview` to the exported package manifest and include every referenced file in `files`, retaining the package's existing exports and publication files:

```json
{
  "preview": {
    "en": "./preview.svg",
    "zh": "./preview.zh.svg"
  },
  "files": ["preview.svg", "preview.zh.svg"]
}
```

Artwork with language-dependent content provides both English and Chinese versions. The map requires `en` as the fallback and uses language IDs such as `zh` or `zh-CN`; the existing UI language resolver selects one image. Keep the subject and layout recognizable across languages, but translate titles, annotations, and sample content. Product names, file names, and official brand marks may remain unchanged.

A language-neutral image can use `"preview": "./preview.svg"`. All paths are relative to the declaring manifest and remain inside its directory after symlink resolution; URLs and absolute paths are rejected. The resource-loading contract, exported-resource alternative, and diagnostics are documented in [plugin display metadata](adding-a-package.md#plugin-display-metadata).

## 4. Check placement in Plugin Manager

Open the real bundle detail page through Plugins. The [detail renderer](../../packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx) and its [styles](../../packages/client/ui-plugin-manager/src/client/PluginManagerPage.module.css) own these rules:

| Item | Current behavior |
|---|---|
| Position | After the package description and before the components section, aligned with the description's left edge. |
| Spacing | 24 px above the image; 32 px before the following detail sections. Authors do not add this outer spacing to the asset. |
| Display size | Keep the intrinsic aspect ratio, fit within the available content width, and cap image height at 320 px. Use `object-fit: contain`; do not crop or stretch. The design canvas is not a fixed screen width. |
| Frame | The page supplies its semantic border color and large-radius token (`--dsw-radius-lg`, currently 16 px). |
| Other views | List cards and component rows keep their small icons. The feature image appears only in bundle details. |
| Optional and failure states | No image means no reserved image space. It is visible before activation. Read or decode failures leave enablement and configuration available. |
| Language and accessibility | Switching the UI language selects the matching image, with English fallback. The image has a localized accessible name derived from the plugin title. Essential instructions also remain available as text outside the image. |

## 5. Verify before opening the PR

1. Run `pnpm run verify-package-meta`, `pnpm run constraints`, and `pnpm run verify-official-bundle-catalog` from the repository root. Include every locale image in publication and resolve resource diagnostics.
2. Build the real application with `pnpm run build && pnpm run build:web`. Inspect the detail page before and after enabling the plugin, in English and Chinese, on a desktop and a 390 px viewport, and in light and dark themes. Check decoding, legibility, clipping, and image placement; restore temporary display settings.
3. Check a bundle with no preview and the affected metadata and UI regressions under the [testing policy](../testing.md). A preview must remain optional and cannot block management when it fails.
4. Follow [official artwork review](../../.agents/skills/dsh-official-plugin-artwork/SKILL.md) and [record-browser-gif](../../.agents/skills/record-browser-gif/SKILL.md). Include a real-page GIF for each language containing translated artwork, recorded against the final PR commit. Show the plugin's actual output when the illustration describes that output.
