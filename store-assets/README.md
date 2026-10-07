# Chrome Web Store Assets

## Brand

Bolt brand mark: a lightning-bolt drawn as an OUTLINE in Bolt brand blue
(`#4d7cff`) on a WHITE background — no gradient, no filled square. Title text
is `#111`, subtext `#666`. This matches the extension toolbar icons
(`scripts/build-browser-extension-brand-assets.mjs`). The old pink/purple
gradient badge is retired.

## Store listing assets (Bolt-branded)

- `store-icon-128.png` — 128×128 store icon (white bg, blue bolt outline).
- `screenshot-1280x800.png` — primary listing screenshot (24-bit PNG, no alpha).
- `promo-small-440x280.png` — small promo tile (24-bit PNG, no alpha).
- `promo-marquee-1400x560.png` — marquee promo tile (24-bit PNG, no alpha).

Regenerate the branded set with:

```bash
python3 store-assets/generate-store-assets.py
```

## Legacy / alternate

- `chrome-store-screenshot-1280x800.png` / `-640x400.png` — older exports of the
  generic browser screenshot (`../playwriter/screenshot@2x.png`); off-brand
  (shows playwriter.dev). Written by `pnpm run extension:assets`.
