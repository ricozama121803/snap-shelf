import { DB_NAME, DB_VERSION, STORE_ITEMS } from "./constants.js";
import { buildSearchBlob } from "./url-utils.js";

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_ITEMS)) {
        const store = db.createObjectStore(STORE_ITEMS, {
          keyPath: "id",
          autoIncrement: true,
        });
        store.createIndex("by_createdAt", "createdAt");
        store.createIndex("by_domain", "domain");
        store.createIndex("by_favorite", "favorite");
        store.createIndex("by_tags", "tags", { multiEntry: true });
        store.createIndex("by_type", "type");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function itemsStore(db, mode) {
  return db.transaction(STORE_ITEMS, mode).objectStore(STORE_ITEMS);
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function addItem(item) {
  const db = await openDB();
  const now = Date.now();
  const record = {
    type: item.type,
    createdAt: now,
    updatedAt: now,
    url: item.url || "",
    textFragmentUrl: item.textFragmentUrl || null,
    title: item.title || "",
    domain: item.domain || "",
    favicon: item.favicon || null,
    textContent: item.textContent || "",
    imageBlob: item.imageBlob || null,
    note: item.note || "",
    tags: item.tags || [],
    favorite: !!item.favorite,
    imageUnavailable: !!item.imageUnavailable,
  };
  record.searchBlob = buildSearchBlob(record);
  const store = itemsStore(db, "readwrite");
  const id = await reqToPromise(store.add(record));
  return { ...record, id };
}

export async function updateItem(id, patch) {
  const db = await openDB();
  const store = itemsStore(db, "readwrite");
  const existing = await reqToPromise(store.get(id));
  if (!existing) throw new Error(`Item ${id} not found`);
  const merged = { ...existing, ...patch, id, updatedAt: Date.now() };
  merged.searchBlob = buildSearchBlob(merged);
  await reqToPromise(store.put(merged));
  return merged;
}

export async function deleteItem(id) {
  const db = await openDB();
  const store = itemsStore(db, "readwrite");
  await reqToPromise(store.delete(id));
}

// Re-inserts a previously deleted record verbatim (same id) - used to back an "Undo" toast
// without leaving a pending timer that would be lost if the side panel closes.
export async function restoreItem(item) {
  const db = await openDB();
  const store = itemsStore(db, "readwrite");
  await reqToPromise(store.put(item));
  return item;
}

export async function getItem(id) {
  const db = await openDB();
  const store = itemsStore(db, "readonly");
  return reqToPromise(store.get(id));
}

// Cursor-scans by_createdAt (already the desired newest-first sort order) applying any
// filters/search in JS. Appropriate for a personal-scale library (hundreds-low thousands of
// items); avoids needing a compound index or search-index library for every filter combo.
export async function queryItems({
  search = "",
  favorite = null,
  tag = null,
  type = null,
  domain = null,
  limit = 50,
  beforeCreatedAt = null,
} = {}) {
  const db = await openDB();
  const store = itemsStore(db, "readonly");
  const index = store.index("by_createdAt");
  const range = beforeCreatedAt != null ? IDBKeyRange.upperBound(beforeCreatedAt, true) : null;
  const searchLower = search.trim().toLowerCase();
  const results = [];

  await new Promise((resolve, reject) => {
    const cursorReq = index.openCursor(range, "prev");
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor || results.length >= limit) {
        resolve();
        return;
      }
      const record = cursor.value;
      let matches = true;
      if (favorite !== null && !!record.favorite !== favorite) matches = false;
      if (matches && type && record.type !== type) matches = false;
      if (matches && domain && record.domain !== domain) matches = false;
      if (matches && tag && !(record.tags || []).includes(tag)) matches = false;
      if (matches && searchLower && !record.searchBlob.includes(searchLower)) matches = false;
      if (matches) results.push(record);
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });

  return results;
}

export async function getAllTags() {
  const db = await openDB();
  const store = itemsStore(db, "readonly");
  const index = store.index("by_tags");
  const tags = new Set();

  await new Promise((resolve, reject) => {
    const cursorReq = index.openKeyCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) {
        resolve();
        return;
      }
      tags.add(cursor.key);
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });

  return Array.from(tags).sort();
}
