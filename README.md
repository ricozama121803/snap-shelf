# Snap Shelf

A Chrome extension for saving the specific piece of a webpage you actually need — a highlighted quote, a cropped screenshot, an image — instead of leaving the whole tab open "for reference."

Everything is saved locally to a searchable Side Panel with thumbnails, tags, favorites, and folders, so you can close the tab and find the thing again later.

## Features

- **Save highlighted text** via the right-click menu
- **Capture a cropped screenshot** of any region of the page (drag-to-select, not the whole viewport)
- **Save images** via the right-click menu
- Every item automatically stores its **page URL, title, favicon, timestamp, and domain**
- Optional **notes** on any saved item
- **Tags** and **favorites**, with filter chips and a tag filter
- **Folders** for organizing items by subject, project, or interest
- **Gallery view** for browsing just your screenshots/images as a grid, with a detail view (image + URL + metadata + actions) on click
- **List view** with search, edit, delete (with undo), copy, and "open original page" (auto-scrolled/highlighted where the browser supports it)
- Fully **keyboard-friendly** side panel
- Built for a **minimal memory footprint**: event-driven service worker, no persistent background page, content scripts injected only when you actually capture something, and screenshots/images compressed to WebP before being stored in IndexedDB

## Installing (unpacked)

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the `snap-shelf` folder.
5. Pin the extension from the toolbar puzzle-piece menu if you'd like quick access.

## Usage

| To save... | Do this |
|---|---|
| Highlighted text | Select text on a page, right-click → **Save selection to Snap Shelf** |
| An image | Right-click any image → **Save image to Snap Shelf** |
| A screenshot region | Right-click empty space on the page → **Capture screenshot region**, then drag to select an area (or press `Ctrl+Shift+S` / `Cmd+Shift+S`) |

Click the toolbar icon to open the **Side Panel**, where everything you've saved lives.

### Side panel keyboard shortcuts

| Key | Action |
|---|---|
| `/` | Focus the search box |
| `↑` / `↓` | Move between items |
| `Enter` | Open the focused item's original page |
| `Delete` / `Backspace` | Delete the focused item (undo toast appears) |
| `F` | Toggle favorite |
| `C` | Copy (text, or image as PNG) |
| `E` | Edit note / tags / folder |
| `Esc` | Clear search or close a dialog |

### Folders

Click the folder icon next to the folder filter to create, rename, or delete folders. Assign an item to a folder from its edit dialog (`E`). Deleting a folder un-assigns its items rather than deleting them.

### Gallery view

Toggle to the grid icon in the header to see only items with a thumbnail (screenshots and images) as a gallery. Click a tile to see the full-size image alongside its URL, title, note, and tags, with the same favorite/edit/copy/open/delete actions as the list view.

## Privacy

Everything is stored locally in your browser's IndexedDB. Snap Shelf makes no network requests of its own beyond fetching the images/screenshots you explicitly ask it to save (and their favicons). Nothing is sent to any server.

## Architecture

Manifest V3, no build step (plain ES modules).

```
manifest.json
background/service-worker.js   event-driven router; owns all IndexedDB writes
content-scripts/               injected on-demand only, never declared in the manifest
offscreen/                     short-lived document that crops/encodes screenshots to WebP
                                (a service worker has no canvas/DOM access)
shared/                        IndexedDB wrapper, message/URL helpers, constants
sidepanel/                     the UI: list view, gallery view, search/filters, dialogs
```

Design choices worth knowing about:

- **`activeTab` instead of `<all_urls>`** — every capture is triggered by a direct user gesture (a context-menu click or the toolbar icon), so no broad host permission is needed.
- **No persistent background page** — the service worker holds no state between events and uses only one-shot `chrome.runtime.sendMessage` (never long-lived ports), so Chrome is free to evict it between captures.
- **Offscreen document, created and closed per capture** — screenshot cropping and WebP encoding need `<canvas>`, which the service worker doesn't have. A `chrome.offscreen` document does that work and is torn down immediately after.
- **IndexedDB, not `chrome.storage`** — screenshots and images are stored as WebP `Blob`s, which `chrome.storage`'s quotas aren't built for.
