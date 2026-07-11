import { CONTEXT_MENU_ID, COMMAND_ID, MESSAGE_TYPE, ITEM_TYPE } from "../shared/constants.js";
import { getDomain, buildTextFragmentUrl, fetchFaviconBlob } from "../shared/url-utils.js";
import { addItem } from "../shared/db.js";
import { broadcast } from "../shared/messaging.js";

const OFFSCREEN_URL = "offscreen/offscreen.html";
const OVERLAY_CSS = "content-scripts/region-overlay.css";
const OVERLAY_JS = "content-scripts/region-overlay.js";
const UNCAPTURABLE_URL_PREFIXES = ["chrome://", "chrome-extension://", "https://chrome.google.com/webstore", "edge://", "about:"];

// --- Registration -----------------------------------------------------------
// Context menu registrations are owned by the browser and persist across service worker
// restarts, so this only needs to run once on install/update - never at module top level.
// The toolbar action is dedicated to opening the side panel (openPanelOnActionClick); Chrome
// does not deliver chrome.action.onClicked events once that's set, so screenshot-region capture
// is triggered instead via a page-context right-click item and the keyboard shortcut below.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    const menus = [
      { id: CONTEXT_MENU_ID.SAVE_SELECTION, title: "Save selection to Snap Shelf", contexts: ["selection"] },
      { id: CONTEXT_MENU_ID.SAVE_IMAGE, title: "Save image to Snap Shelf", contexts: ["image"] },
      { id: CONTEXT_MENU_ID.CAPTURE_REGION, title: "Capture screenshot region for Snap Shelf", contexts: ["page"] },
    ];
    for (const menu of menus) {
      chrome.contextMenus.create(menu, () => {
        if (chrome.runtime.lastError) {
          console.error("[snap-shelf] context menu create failed", menu.id, chrome.runtime.lastError.message);
        }
      });
    }
  });
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => console.error("[snap-shelf] setPanelBehavior failed", err));
});

// --- Event routing ------------------------------------------------------------
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  if (info.menuItemId === CONTEXT_MENU_ID.SAVE_SELECTION) {
    handleSaveSelection(info, tab).catch((err) => console.error("[snap-shelf] save selection failed", err));
  } else if (info.menuItemId === CONTEXT_MENU_ID.SAVE_IMAGE) {
    handleSaveImage(info, tab).catch((err) => console.error("[snap-shelf] save image failed", err));
  } else if (info.menuItemId === CONTEXT_MENU_ID.CAPTURE_REGION) {
    handleStartRegionCapture(tab).catch((err) => console.error("[snap-shelf] region capture failed", err));
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== COMMAND_ID.START_REGION_CAPTURE) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    handleStartRegionCapture(tab).catch((err) => console.error("[snap-shelf] region capture failed", err));
  }
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === MESSAGE_TYPE.REGION_SELECTED) {
    handleRegionSelected(message, sender).catch((err) => console.error("[snap-shelf] region selected handling failed", err));
  }
  return false;
});

// --- Capture flow 1: text selection --------------------------------------------
async function handleSaveSelection(info, tab) {
  const url = tab.url || "";
  const domain = getDomain(url);
  const textContent = info.selectionText || "";
  const favicon = await fetchFaviconBlob(tab.favIconUrl);

  const item = await addItem({
    type: ITEM_TYPE.TEXT,
    url,
    title: tab.title || domain,
    domain,
    favicon,
    textContent,
    textFragmentUrl: buildTextFragmentUrl(url, textContent),
  });

  await broadcast({ type: MESSAGE_TYPE.ITEM_SAVED, id: item.id });
}

// --- Capture flow 2: screenshot region ------------------------------------------
async function handleStartRegionCapture(tab) {
  if (!tab?.id || !tab.url) return;
  if (UNCAPTURABLE_URL_PREFIXES.some((prefix) => tab.url.startsWith(prefix))) {
    console.warn("[snap-shelf] cannot capture on this page:", tab.url);
    return;
  }
  await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: [OVERLAY_CSS] });
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [OVERLAY_JS] });
}

async function handleRegionSelected(message, sender) {
  const tab = sender.tab;
  if (!tab) return;
  const { rect, devicePixelRatio } = message;

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const rectPx = {
    x: Math.round(rect.x * devicePixelRatio),
    y: Math.round(rect.y * devicePixelRatio),
    width: Math.round(rect.width * devicePixelRatio),
    height: Math.round(rect.height * devicePixelRatio),
  };

  await ensureOffscreenDocument();
  const encoded = await sendToOffscreen({
    type: MESSAGE_TYPE.CROP_AND_ENCODE,
    dataUrl,
    rectPx,
  });
  await closeOffscreenDocument();

  if (!encoded?.ok) {
    console.error("[snap-shelf] screenshot crop/encode failed", encoded?.error);
    return;
  }

  const url = tab.url || "";
  const domain = getDomain(url);
  const favicon = await fetchFaviconBlob(tab.favIconUrl);
  const imageBlob = await (await fetch(encoded.dataUrl)).blob();

  const item = await addItem({
    type: ITEM_TYPE.SCREENSHOT,
    url,
    title: tab.title || domain,
    domain,
    favicon,
    imageBlob,
  });

  await broadcast({ type: MESSAGE_TYPE.ITEM_SAVED, id: item.id });
}

// --- Capture flow 3: image ------------------------------------------------------
async function handleSaveImage(info, tab) {
  const url = tab.url || "";
  const domain = getDomain(url);
  const favicon = await fetchFaviconBlob(tab.favIconUrl);
  const srcUrl = info.srcUrl;

  await ensureOffscreenDocument();
  let encoded = await sendToOffscreen({ type: MESSAGE_TYPE.FETCH_AND_ENCODE_IMAGE, srcUrl });

  if (!encoded?.ok) {
    // Primary path (fetch from the offscreen document) can fail for CORS/auth-gated images.
    // Fall back to fetching from within the source tab's own origin, which is not subject to
    // the same cross-origin restrictions the extension-page fetch is.
    encoded = await fallbackFetchImageViaContentScript(tab.id, srcUrl);
  }
  await closeOffscreenDocument();

  const imageBlob = encoded?.ok ? await (await fetch(encoded.dataUrl)).blob() : null;

  const item = await addItem({
    type: ITEM_TYPE.IMAGE,
    url,
    title: tab.title || domain,
    domain,
    favicon,
    imageBlob,
    imageUnavailable: !encoded?.ok,
  });

  await broadcast({ type: MESSAGE_TYPE.ITEM_SAVED, id: item.id });
}

async function fallbackFetchImageViaContentScript(tabId, srcUrl) {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (imageUrl) => {
        try {
          const res = await fetch(imageUrl);
          if (!res.ok) return null;
          const blob = await res.blob();
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
          return { dataUrl };
        } catch {
          return null;
        }
      },
      args: [srcUrl],
    });
    const raw = injection?.result;
    if (!raw) return { ok: false };

    await ensureOffscreenDocument();
    return await sendToOffscreen({
      type: MESSAGE_TYPE.FETCH_AND_ENCODE_IMAGE,
      dataUrl: raw.dataUrl,
    });
  } catch (err) {
    console.error("[snap-shelf] fallback image fetch failed", err);
    return { ok: false, error: String(err) };
  }
}

// --- Offscreen document lifecycle -------------------------------------------------
async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["DOM_PARSER"],
    justification: "Crop screenshots and encode images to WebP using canvas, which is unavailable in the service worker.",
  });
}

async function closeOffscreenDocument() {
  try {
    const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (existing.length > 0) {
      await chrome.offscreen.closeDocument();
    }
  } catch {
    // already closed - ignore
  }
}

async function sendToOffscreen(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (err) {
    console.error("[snap-shelf] offscreen message failed", err);
    return { ok: false, error: String(err) };
  }
}
