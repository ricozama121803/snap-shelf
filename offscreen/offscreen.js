import { MESSAGE_TYPE, WEBP_QUALITY } from "../shared/constants.js";

// Stateless image-processing worker: receives bytes, returns bytes. Never touches IndexedDB.
// Runs entirely in this short-lived offscreen document because the service worker has no
// DOM/canvas access needed for cropping and WebP encoding.
//
// All binary payloads cross chrome.runtime.sendMessage as data: URL strings, not ArrayBuffer -
// extension messaging requires JSON-serializable payloads and silently drops ArrayBuffer fields.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === MESSAGE_TYPE.CROP_AND_ENCODE) {
    cropAndEncode(message).then(sendResponse);
    return true;
  }
  if (message?.type === MESSAGE_TYPE.FETCH_AND_ENCODE_IMAGE) {
    fetchAndEncode(message).then(sendResponse);
    return true;
  }
  return false;
});

async function cropAndEncode({ dataUrl, rectPx }) {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);

    const x = Math.max(0, Math.min(rectPx.x, bitmap.width - 1));
    const y = Math.max(0, Math.min(rectPx.y, bitmap.height - 1));
    const width = Math.max(1, Math.min(rectPx.width, bitmap.width - x));
    const height = Math.max(1, Math.min(rectPx.height, bitmap.height - y));

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, x, y, width, height, 0, 0, width, height);
    bitmap.close();

    return await encodeCanvas(canvas);
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function fetchAndEncode({ srcUrl, dataUrl }) {
  try {
    const blob = dataUrl ? await (await fetch(dataUrl)).blob() : await (await fetch(srcUrl)).blob();

    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    return await encodeCanvas(canvas);
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function encodeCanvas(canvas) {
  const webpBlob = await canvas.convertToBlob({ type: "image/webp", quality: WEBP_QUALITY });
  const dataUrl = await blobToDataUrl(webpBlob);
  return { ok: true, dataUrl, mimeType: "image/webp" };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
