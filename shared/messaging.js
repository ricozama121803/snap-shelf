// Thin wrapper around chrome.runtime.sendMessage. Broadcasts (e.g. ITEM_SAVED to a side
// panel that may not be open) are expected to sometimes have no listener - that's not an error.
export async function sendMessage(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (err) {
    if (err?.message?.includes("Receiving end does not exist")) {
      return undefined;
    }
    throw err;
  }
}

export async function broadcast(message) {
  return sendMessage(message);
}
