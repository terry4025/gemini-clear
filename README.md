# GeminiClear

Local browser-based Gemini watermark remover with full-resolution export.

## What It Does

- Uploads PNG, JPG, and WEBP images entirely in the browser
- Lets you paint a manual mask over the watermark area
- Suggests a conservative auto-detect mask for the typical Gemini bottom-right watermark
- Removes the watermark locally and exports a full-resolution PNG
- Shows a before/after comparison inside the app

## Stack

- `index.html`
- `style.css`
- `app.js`
- `opencv.js`

No backend is required. Images stay local to the browser.

## Run Locally

Serve the folder with any static file server.

Example with Python:

```bash
python -m http.server 8080
```

Then open:

```text
http://127.0.0.1:8080/index.html
```

## How To Use

1. Upload an image.
2. Turn on `Auto-Detect` if the watermark is in the usual bottom-right area.
3. Refine the mask manually if needed.
4. Click `Erase Watermark`.
5. Review the comparison slider.
6. Download the full-resolution PNG.

## Current Limits

- Auto-detect is tuned for the common small Gemini watermark near the bottom-right corner.
- Complex overlays or unusual watermark placements may still need manual masking.
- OpenCV runs locally in the browser, so very large images may take longer to process.

## Validation

- `node --check app.js`
- Browser verification of upload, auto-detect, erase, comparison, and download flows
