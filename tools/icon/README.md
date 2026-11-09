# VoiceDock icon

The VoiceDock mark: a voice, as sound bars, rising off its dock.
It is the same mark as the VoiceDock page on n8builds.dev.

- `voicedock.svg` is the mark, used for the 48 and 128 px icons.
- `voicedock-16.svg` and `voicedock-32.svg` are copies drawn on the pixel grid, so the bars stay sharp in the toolbar.

The PNGs in `extension/icons/` are rendered from these files with any SVG rasterizer (a browser canvas works):

| File | Source | Drawn at |
| --- | --- | --- |
| `icon16.png` | `voicedock-16.svg` | 16x16, full bleed |
| `icon32.png` | `voicedock-32.svg` | 32x32, full bleed |
| `icon48.png` | `voicedock.svg` | 48x48, full bleed |
| `icon128.png` | `voicedock.svg` | 96x96 centred in 128x128 (16 px transparent padding, as the Chrome Web Store asks) |
