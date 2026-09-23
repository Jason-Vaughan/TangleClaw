# TangleClaw Design Specs

## Wordmark Logo
The dashboard wordmark is not live text or a loaded font—it is a raster image.

- **Original Source File**: `/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder1/public/logo-text.png`
- **Size**: 1668 x 292 RGBA
- **Usage**: Loaded in `TangleClaw-Builder1/public/index.html:37` and displayed at 16px high by `TangleClaw-Builder1/public/style.css:123`

### Notes on Typography
The repository does not record the original font or contain an editable source. Visually, it resembles **Eurostile Bold Extended** or a close square-geometric derivative, but this cannot be proven from the asset history.

If the PNG fails to load in the dashboard, it falls back to bold system/SF Pro text—but that is not the official wordmark shown in the screenshots.

### TODO: SVG Master
For the website, we are currently reusing `logo-text.png` for an exact visual match.
**Longer term:** We need to create a proper SVG master for the wordmark and formally record the typeface and license.
