# Gemini Watermark Remover

Browser-only Gemini watermark remover for the usual small watermark near the bottom-right corner.

## What It Does

- Accepts PNG, JPG, and WebP files
- Starts processing immediately after select, drag-and-drop, or paste
- Removes the detected Gemini watermark locally in the browser
- Automatically downloads the result as a PNG named `_no_watermark.png`
- Keeps a before/after comparison view on screen after the download starts

## Run

You can use either of these modes:

1. Open `index.html` directly in a desktop browser
2. Serve the folder with a static server

Example static server:

```bash
py -3 -m http.server 8080
```

Then open:

```text
http://127.0.0.1:8080/index.html
```

## Usage

1. Select an image, drag it in, or paste it
2. Wait for detection, removal, and PNG export
3. The PNG download starts automatically
4. Use the slider to compare the original and cleaned image
5. Click `다른 이미지` to process another file

## Limits

- Detection is tuned for the standard Gemini watermark near the bottom-right edge
- Unusual placements or non-Gemini watermarks are out of scope
- Very large images may take longer because everything runs locally
- Some browsers may block automatic downloads; in that case the result view shows a fallback save link

## Validation

- `node --check app.js`
- `node --check worker.js` is no longer needed because the worker now lives inside `app.js`
- Browser-check upload, paste, drag-and-drop, comparison, and automatic PNG download
