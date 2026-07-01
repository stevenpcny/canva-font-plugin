# Canva 批量字号

A Chrome extension that batch-applies font size, position, highlight animation, and AI-powered caption proofreading to Canva designs — across all pages in one click.

## Features

- **Batch font size** — Set all caption text to a target size; skip small watermark text via a threshold
- **Caption position** — Read position from one page and apply uniformly to all pages
- **Highlight animation** — Apply Canva's Highlight animation with a custom color to all caption elements
- **AI proofreading** — Extract captions via the Transcript panel and fix capitalization/punctuation with Gemini or OpenRouter
- **Batch page creation** — Add multiple blank pages at once
- **Video placement** — Place videos from an Uploads folder onto new pages sequentially

## Installation

1. Download the latest release zip from the [Releases](../../releases) page
2. Unzip the file
3. Open Chrome → `chrome://extensions/` → enable **Developer mode**
4. Click **Load unpacked** and select the unzipped folder

## Usage

1. Open a design in Canva (`canva.com/design/…`)
2. Click the extension icon to open the side panel
3. Set your target font size and threshold, then click **应用到所有页面**

## Release

Latest release: [v1.0.0](../../releases/tag/v1.0.0)

Releases are built automatically via GitHub Actions on each version tag push. The release asset is a zip package ready for Chrome's "Load unpacked" installer.

## Permissions

| Permission | Reason |
|-----------|--------|
| `debugger` | Send trusted input events to Canva canvas |
| `tabs` | Detect active Canva tab |
| `storage` | Persist API keys and settings |
| `sidePanel` | Render the control panel as a Chrome side panel |

## License

MIT
