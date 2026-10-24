# Media Frame Control

[简体中文](README.md) ｜ **English**

> **Author**: bayunhuiye ｜ **Version**: 1.0.0 ｜ **Min Obsidian version**: 1.4.0

Two things Obsidian does not do well natively, fixed:

1. **GIF frame stepping** — click a GIF to get "previous frame / play-pause / next frame" plus a frame counter
2. **Video playback speed** — a 0.1x–3.0x speed selector inside the video frame; click the video itself to select it

## Installation

### Option 1: Manual install

Copy the whole `media-frame-control` folder into:

```
<your vault>/.obsidian/plugins/media-frame-control/
```

Then in Obsidian: Settings → Community plugins → turn off Safe mode → enable **Media Frame Control** under Installed plugins.

If it does not show up, restart Obsidian once more (plugin registration requires a directory rescan).

### Option 2: Download from GitHub

Download `main.js`, `manifest.json` and `styles.css` from the repository, put them in `<your vault>/.obsidian/plugins/media-frame-control/`, then enable the plugin.

### Option 3: Install with BRAT

Install [BRAT](https://github.com/TfTHacker/obsidian42-brat), then in BRAT settings use Add Beta plugin and enter `bayunhuiye/media-frame-control`.

## Usage

### GIF

**One click both selects the GIF and enters frame-stepping mode** — no second click needed. The GIF keeps playing (it does not auto-pause); click pause when you want to freeze on a frame.

A control bar floats over the top of the image (visible on hover or while selected):

- `◀` previous frame
- `▶` / `⏸` play or pause
- `▶` (right) next frame
- `12 / 48` current frame / total frames
- `×` exit frame-stepping mode and restore the original GIF

The control bar is an overlay pinned to the top of the image, so it **never takes an extra line**. It stays semi-transparent and hidden normally and appears on hover. Icons are monochrome SVG (they follow the text colour) and only use neutral grey — no colour at all.

When the control bar or the canvas has focus, the keyboard also works:

- `←` previous frame
- `→` next frame
- `Space` play / pause
- `Delete` / `Backspace` remove this embed
- `Esc` clear selection

Only one GIF can be in frame-stepping mode at a time (to avoid several decoders eating memory); opening a second one automatically closes the first.

### Video

**The speed bar is not shown normally — it only appears when the mouse is over the video** (inside the top-right corner) and hides when the mouse leaves. It does not stay on screen just because the video is selected.

- The dropdown offers 0.1 / 0.25 / 0.5 / 0.75 / 1 / 1.25 / 1.5 / 2 / 2.5 / 3
- Changes apply immediately; no need to press play
- Clicking the video image itself selects it (blue outline), so you do not have to click the `![[xxx.mp4]]` line
- Loop button on the right: **on by default**; a brighter ring means on, a dimmer one means off; each video can be toggled independently

### Clearing the selection

After selecting an image / GIF / video, any of the following clears the selection:

- Clicking anywhere blank on the page (note body or sidebar)
- Pressing `Esc`
- Moving focus elsewhere

Clicking the selected element itself (including the frame control bar and speed bar) does not clear it.

### Deleting after selecting

Click an image / GIF / video to select it (blue outline), then:

- `Delete` removes the embed, and **if that line contains only this embed, the whole line goes too**, leaving no blank line
- `Backspace` removes only the embed and keeps the empty line
- `Esc` clears the selection

A GIF needs only one click: selection and frame stepping happen together, so you can press `Delete` right away.

**This only edits the note text; it does not delete files and does not use the trash.** To remove files from disk, delete them in the file explorer.

All of these forms are recognised and removed correctly: `![[clip.mp4]]`, `![[folder/clip.mp4]]`, `![[a.png|300]]`, `![](path)`. When the same embed appears several times in the same paragraph, the one **closest to the cursor** is removed.

## Settings

| Setting | Description |
|---|---|
| Enable plugin | Master switch |
| GIF frame stepping | When off, clicking a GIF does nothing |
| Video playback speed | When off, no speed selector is injected |
| Speed options | Comma-separated; values outside 0.1–3 are ignored |
| Default speed | Initial speed for new videos; out-of-range values are clamped |
| Loop by default | Videos loop by default (enabled); changes apply immediately to rendered videos |
| Max GIF frames | GIFs above this skip frame stepping (default 400) so long animations cannot hang |
| Max GIF size (MB) | GIFs above this skip frame stepping (default 80) |
| Arrow keys and Delete | When off, selected media no longer responds to Delete |

## Implementation notes

**GIFs are never modified on disk.** Decoding happens entirely in memory:

```js
const decoder = new ImageDecoder({ data: buffer, type: 'image/gif' });
const frame = await decoder.decode({ frameIndex: n });
ctx.drawImage(frame.image, 0, 0);
```

This uses Chromium's built-in `ImageDecoder` with no third-party library. The canvas is only a display layer; the `.gif` file in your vault keeps its format, contents and size, and still opens in any other application.

**Videos are not modified either** — the plugin only sets the `<video>` element's `playbackRate` property.

**Embed removal does not build a regex from the link text.** The note may say `![[clip.mp4]]` (shortest path) while the DOM element only exposes the full path, and when the two do not match you get "embed not found in the note". The current approach matches in three passes, loosening each time:

1. The link in the note resolves to the same file via `metadataCache.getFirstLinkpathDest`
2. The link text equals the element's `alt` / `src` verbatim (closest to how the user actually wrote it)
3. The filename is unique in the note

That covers shortest paths, paths with folders, paths with size suffixes and Markdown syntax; identically named files are still distinguished precisely by pass 2.

**Selection and Delete still work in frame-stepping mode:** the original `<img>` is hidden once frame stepping starts, so the selection and `Delete` listeners are attached to the new canvas / overlay container, which remembers the matching `TFile` and the original link text instead of relying on the hidden `img`.

**Selection is cleared by a document capture-phase listener:** clicks on the media itself (including the control bar and speed bar) call `stopPropagation`, so anything reaching `document` must be a click elsewhere and simply clears the selection. These listeners are removed when the plugin unloads.

## Known limitations

- GIF frame stepping relies on `ImageDecoder` and needs a reasonably recent Obsidian (bundled Chromium 94+). Older versions show "not supported in this environment".
- GIFs above the frame or size limits are played as-is without frame stepping.
- Only embeds in the note body are handled; media inside Canvas is not.
- Only one GIF can be stepped at a time — this is deliberate memory protection.

## Uninstall

Turn the switch off in settings, or delete the plugin folder. It does not affect any notes or attachment files.
