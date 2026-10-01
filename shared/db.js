import { DB_NAME, DB_VERSION, STORE_ITEMS, STORE_FOLDERS } from "./constants.js";
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
      if (!db.objectStoreNames.contains(STORE_FOLDERS)) {
        const folderStore = db.createObjectStore(STORE_FOLDERS, {
          keyPath: "id",
          autoIncrement: true,
        });
        folderStore.createIndex("by_name", "name");
      }
    };
    // If another open tab/panel is still holding a connection to an older DB version, the
    // upgrade transaction above stalls indefinitely with no error unless we react here.
    req.onblocked = () => {
      console.warn(
        "[snap-shelf] IndexedDB upgrade blocked by another open Snap Shelf tab/panel - close it and retry."
      );
    };
    req.onsuccess = () => {
      const db = req.result;
      // Let this connection get out of the way of a *future* version bump instead of
      // silently blocking it the same way, if this page is left open across an update.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function itemsStore(db, mode) {
  return db.transaction(STORE_ITEMS, mode).objectStore(STORE_ITEMS);
}

function foldersStore(db, mode) {
  return db.transaction(STORE_FOLDERS, mode).objectStore(STORE_FOLDERS);
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
    folderId: item.folderId ?? null,
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

// Bulk helpers for the "Delete items" dialog. `type` null = every type.
function matchesPurge(item, { type, keepFavorites }) {
  if (type && item.type !== type) return false;
  if (keepFavorites && item.favorite) return false;
  return true;
}

function scanItems(db, mode, visit) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ITEMS, mode);
    const req = tx.objectStore(STORE_ITEMS).openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        visit(cursor);
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function countPurgeable(opts = {}) {
  const db = await openDB();
  let count = 0;
  await scanItems(db, "readonly", (cursor) => {
    if (matchesPurge(cursor.value, opts)) count++;
  });
  return count;
}

export async function purgeItems(opts = {}) {
  const db = await openDB();
  let count = 0;
  await scanItems(db, "readwrite", (cursor) => {
    if (matchesPurge(cursor.value, opts)) {
      cursor.delete();
      count++;
    }
  });
  return count;
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
  folderId = undefined, // undefined = no filter, null = unfiled only, number = a specific folder
  hasImage = false,
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
      if (matches && folderId !== undefined && (record.folderId ?? null) !== folderId) matches = false;
      if (matches && hasImage && !record.imageBlob) matches = false;
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

// --- Folders --------------------------------------------------------------------
export async function addFolder(name) {
  const db = await openDB();
  const store = foldersStore(db, "readwrite");
  const record = { name: name.trim(), createdAt: Date.now() };
  const id = await reqToPromise(store.add(record));
  return { ...record, id };
}

export async function getAllFolders() {
  const db = await openDB();
  const store = foldersStore(db, "readonly");
  const folders = await reqToPromise(store.getAll());
  return folders.sort((a, b) => a.name.localeCompare(b.name));
}

export async function renameFolder(id, name) {
  const db = await openDB();
  const store = foldersStore(db, "readwrite");
  const existing = await reqToPromise(store.get(id));
  if (!existing) throw new Error(`Folder ${id} not found`);
  const updated = { ...existing, name: name.trim() };
  await reqToPromise(store.put(updated));
  return updated;
}

// Deletes a folder and un-assigns it from any items that referenced it, in one transaction.
export async function deleteFolder(id) {
  const db = await openDB();
  const tx = db.transaction([STORE_ITEMS, STORE_FOLDERS], "readwrite");
  const items = tx.objectStore(STORE_ITEMS);
  const folders = tx.objectStore(STORE_FOLDERS);

  await new Promise((resolve, reject) => {
    const cursorReq = items.openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) {
        resolve();
        return;
      }
      if (cursor.value.folderId === id) {
        cursor.update({ ...cursor.value, folderId: null });
      }
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });

  await reqToPromise(folders.delete(id));
}
