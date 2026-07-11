import { queryItems, updateItem, deleteItem, restoreItem, getAllTags } from "../shared/db.js";
import { MESSAGE_TYPE, ITEM_TYPE } from "../shared/constants.js";

const PAGE_SIZE = 40;
const TOAST_UNDO_MS = 5000;
const TOAST_INFO_MS = 1500;

const FALLBACK_FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="gray" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20"/></svg>'
  );

const state = {
  items: [],
  filter: { type: "all", tag: "" },
  search: "",
  focusedIndex: -1,
  objectUrls: new Map(), // itemId -> { thumb?, favicon? }
};

const el = {
  searchInput: document.getElementById("search-input"),
  filterRow: document.getElementById("filter-row"),
  tagFilter: document.getElementById("tag-filter"),
  itemList: document.getElementById("item-list"),
  emptyState: document.getElementById("empty-state"),
  loadMoreBtn: document.getElementById("load-more"),
  toast: document.getElementById("toast"),
  toastMessage: document.getElementById("toast-message"),
  toastUndo: document.getElementById("toast-undo"),
  cardTemplate: document.getElementById("item-card-template"),
  editDialog: document.getElementById("edit-dialog"),
  editForm: document.getElementById("edit-form"),
  editNote: document.getElementById("edit-note"),
  editTagsList: document.getElementById("edit-tags-list"),
  editTagsInput: document.getElementById("edit-tags-input"),
  editCancel: document.getElementById("edit-cancel"),
  imageModal: document.getElementById("image-modal"),
  imageModalImg: document.getElementById("image-modal-img"),
  imageModalClose: document.getElementById("image-modal-close"),
};

let editingItem = null;
let editingTags = [];
let searchDebounceTimer = null;
let toastTimer = null;
let modalObjectUrl = null;

init();

async function init() {
  bindEvents();
  await refreshTagFilterOptions();
  await loadItems({ reset: true });
}

// --- Data loading -----------------------------------------------------------------
function currentQueryOptions(extra = {}) {
  const opts = { search: state.search, limit: PAGE_SIZE, ...extra };
  if (state.filter.type === "favorite") opts.favorite = true;
  else if (state.filter.type !== "all") opts.type = state.filter.type;
  if (state.filter.tag) opts.tag = state.filter.tag;
  return opts;
}

async function loadItems({ reset }) {
  if (reset) {
    revokeAllObjectUrls();
    state.items = [];
    state.focusedIndex = -1;
    el.itemList.textContent = "";
  }
  const beforeCreatedAt = reset ? null : state.items.at(-1)?.createdAt ?? null;
  const batch = await queryItems(currentQueryOptions({ beforeCreatedAt }));
  state.items.push(...batch);
  for (const item of batch) el.itemList.appendChild(buildCard(item));
  el.loadMoreBtn.hidden = batch.length < PAGE_SIZE;
  updateEmptyState();
}

function updateEmptyState() {
  const isEmpty = state.items.length === 0;
  el.emptyState.hidden = !isEmpty;
  el.itemList.hidden = isEmpty;
}

async function refreshTagFilterOptions() {
  const tags = await getAllTags();
  const current = el.tagFilter.value;
  el.tagFilter.textContent = "";
  const allOpt = document.createElement("option");
  allOpt.value = "";
  allOpt.textContent = "All tags";
  el.tagFilter.appendChild(allOpt);
  for (const tag of tags) {
    const opt = document.createElement("option");
    opt.value = tag;
    opt.textContent = tag;
    el.tagFilter.appendChild(opt);
  }
  el.tagFilter.value = tags.includes(current) ? current : "";
}

// --- Card rendering -----------------------------------------------------------------
function buildCard(item) {
  const node = el.cardTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.id = String(item.id);
  node.tabIndex = -1;
  node.classList.toggle("favorited", !!item.favorite);

  renderThumb(node.querySelector(".card-thumb"), item);
  renderFavicon(node.querySelector(".favicon"), item);

  node.querySelector(".domain").textContent = item.domain || "";
  const timeEl = node.querySelector(".timestamp");
  timeEl.textContent = formatTimestamp(item.createdAt);
  timeEl.dateTime = new Date(item.createdAt).toISOString();

  node.querySelector(".card-title").textContent = item.title || item.domain || "Untitled";

  let snippet = "";
  if (item.type === ITEM_TYPE.TEXT) snippet = item.textContent || "";
  else if (item.type === ITEM_TYPE.IMAGE && item.imageUnavailable) {
    snippet = "Image unavailable — the source blocked this download.";
  }
  node.querySelector(".card-snippet").textContent = snippet;
  node.querySelector(".card-note").textContent = item.note || "";
  renderTags(node.querySelector(".card-tags"), item);

  const favBtn = node.querySelector(".action-favorite");
  favBtn.classList.toggle("active", !!item.favorite);
  favBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFavorite(item.id);
  });
  node.querySelector(".action-edit").addEventListener("click", (e) => {
    e.stopPropagation();
    openEditor(item.id);
  });
  node.querySelector(".action-copy").addEventListener("click", (e) => {
    e.stopPropagation();
    copyItem(item.id);
  });
  node.querySelector(".action-open").addEventListener("click", (e) => {
    e.stopPropagation();
    openItem(item.id);
  });
  node.querySelector(".action-delete").addEventListener("click", (e) => {
    e.stopPropagation();
    deleteItemWithUndo(item.id);
  });

  node.addEventListener("click", () => focusCard(item.id));
  node.addEventListener("dblclick", () => openItem(item.id));

  return node;
}

function renderThumb(container, item) {
  container.textContent = "";
  container.classList.remove("expandable");
  if ((item.type === ITEM_TYPE.SCREENSHOT || item.type === ITEM_TYPE.IMAGE) && item.imageBlob) {
    const url = URL.createObjectURL(item.imageBlob);
    trackObjectUrl(item.id, "thumb", url);
    const img = document.createElement("img");
    img.src = url;
    img.alt = "";
    container.appendChild(img);
    container.classList.add("expandable");
    container.title = "Click to expand";
    container.addEventListener("click", (e) => {
      e.stopPropagation();
      openImageModal(item);
    });
  } else {
    container.appendChild(placeholderIcon(item));
  }
}

function openImageModal(item) {
  if (!item.imageBlob) return;
  if (modalObjectUrl) URL.revokeObjectURL(modalObjectUrl);
  modalObjectUrl = URL.createObjectURL(item.imageBlob);
  el.imageModalImg.src = modalObjectUrl;
  el.imageModalImg.alt = item.title || "";
  el.imageModal.showModal();
}

function renderFavicon(img, item) {
  if (item.favicon) {
    const url = URL.createObjectURL(item.favicon);
    trackObjectUrl(item.id, "favicon", url);
    img.src = url;
  } else {
    img.src = FALLBACK_FAVICON;
  }
}

function renderTags(container, item) {
  container.textContent = "";
  for (const tag of item.tags || []) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "tag-chip";
    chip.textContent = tag;
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      setTagFilter(tag);
    });
    container.appendChild(chip);
  }
}

function placeholderIcon(item) {
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "icon icon-sm");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  const path = document.createElementNS(svgNS, "path");
  path.setAttribute(
    "d",
    item.type === ITEM_TYPE.TEXT ? "M4 6h16M4 12h16M4 18h10" : "M4 4h16v16H4z M9 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2z M20 15l-5-5-9 9"
  );
  svg.appendChild(path);
  return svg;
}

function formatTimestamp(ts) {
  const diff = Date.now() - ts;
  const min = 60000;
  const hr = 3600000;
  const day = 86400000;
  if (diff < min) return "just now";
  if (diff < hr) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hr)}h ago`;
  if (diff < day * 7) return `${Math.floor(diff / day)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function cardEl(id) {
  return el.itemList.querySelector(`.item-card[data-id="${id}"]`);
}

// --- Object URL lifecycle -----------------------------------------------------------
function trackObjectUrl(id, key, url) {
  let entry = state.objectUrls.get(id);
  if (!entry) {
    entry = {};
    state.objectUrls.set(id, entry);
  }
  if (entry[key]) URL.revokeObjectURL(entry[key]);
  entry[key] = url;
}

function revokeItemObjectUrls(id) {
  const entry = state.objectUrls.get(id);
  if (!entry) return;
  for (const url of Object.values(entry)) {
    if (url) URL.revokeObjectURL(url);
  }
  state.objectUrls.delete(id);
}

function revokeAllObjectUrls() {
  for (const id of Array.from(state.objectUrls.keys())) revokeItemObjectUrls(id);
}

// --- Actions -----------------------------------------------------------------------
async function toggleFavorite(id) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  const updated = await updateItem(id, { favorite: !item.favorite });
  item.favorite = updated.favorite;

  if (state.filter.type === "favorite" && !item.favorite) {
    removeCardFromView(id);
    return;
  }
  const card = cardEl(id);
  if (card) {
    card.classList.toggle("favorited", item.favorite);
    card.querySelector(".action-favorite").classList.toggle("active", item.favorite);
  }
}

function removeCardFromView(id) {
  const idx = state.items.findIndex((i) => i.id === id);
  if (idx !== -1) state.items.splice(idx, 1);
  if (state.focusedIndex >= state.items.length) state.focusedIndex = state.items.length - 1;
  const card = cardEl(id);
  if (card) card.remove();
  revokeItemObjectUrls(id);
  updateEmptyState();
}

function deleteItemWithUndo(id) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  removeCardFromView(id);

  deleteItem(id).catch((err) => console.error("[snap-shelf] delete failed", err));
  refreshTagFilterOptions();

  showToast("Item deleted", async () => {
    await restoreItem(item);
    await refreshTagFilterOptions();
    await loadItems({ reset: true });
  });
}

async function copyItem(id) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  try {
    if (item.type === ITEM_TYPE.TEXT) {
      await navigator.clipboard.writeText(item.textContent || item.note || "");
    } else if (item.imageBlob) {
      const pngBlob = await webpToPng(item.imageBlob);
      await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
    } else {
      await navigator.clipboard.writeText(item.url || "");
    }
    showToast("Copied to clipboard");
  } catch (err) {
    console.error("[snap-shelf] copy failed", err);
    showToast("Copy failed");
  }
}

async function webpToPng(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas.convertToBlob({ type: "image/png" });
}

function openItem(id) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  const url = item.textFragmentUrl || item.url;
  if (url) chrome.tabs.create({ url });
}

function setTagFilter(tag) {
  el.tagFilter.value = tag;
  state.filter.tag = tag;
  loadItems({ reset: true });
}

// --- Edit dialog -------------------------------------------------------------------
function openEditor(id) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  editingItem = item;
  editingTags = [...(item.tags || [])];
  el.editNote.value = item.note || "";
  el.editTagsInput.value = "";
  renderEditTags();
  el.editDialog.showModal();
  el.editNote.focus();
}

function renderEditTags() {
  el.editTagsList.textContent = "";
  for (const tag of editingTags) {
    const chip = document.createElement("span");
    chip.className = "edit-tag-chip";
    const label = document.createElement("span");
    label.textContent = tag;
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.textContent = "×";
    removeBtn.setAttribute("aria-label", `Remove tag ${tag}`);
    removeBtn.addEventListener("click", () => {
      editingTags = editingTags.filter((t) => t !== tag);
      renderEditTags();
    });
    chip.append(label, removeBtn);
    el.editTagsList.appendChild(chip);
  }
}

function updateCardInPlace(item) {
  const card = cardEl(item.id);
  if (!card) return;
  card.querySelector(".card-note").textContent = item.note || "";
  renderTags(card.querySelector(".card-tags"), item);
}

// --- Toast -----------------------------------------------------------------------
function showToast(message, onUndo) {
  clearTimeout(toastTimer);
  el.toastMessage.textContent = message;
  el.toastUndo.hidden = !onUndo;
  el.toastUndo.onclick = onUndo
    ? () => {
        onUndo();
        hideToast();
      }
    : null;
  el.toast.hidden = false;
  toastTimer = setTimeout(hideToast, onUndo ? TOAST_UNDO_MS : TOAST_INFO_MS);
}

function hideToast() {
  el.toast.hidden = true;
  clearTimeout(toastTimer);
}

// --- Keyboard navigation -----------------------------------------------------------
function moveFocus(delta) {
  if (state.items.length === 0) return;
  const next = Math.max(0, Math.min(state.items.length - 1, state.focusedIndex + delta));
  focusCardByIndex(next);
}

function focusCardByIndex(index) {
  const prevItem = state.items[state.focusedIndex];
  if (prevItem) {
    const prevCard = cardEl(prevItem.id);
    if (prevCard) {
      prevCard.tabIndex = -1;
      prevCard.classList.remove("focused");
    }
  }
  state.focusedIndex = index;
  const item = state.items[index];
  if (!item) return;
  const card = cardEl(item.id);
  if (card) {
    card.tabIndex = 0;
    card.classList.add("focused");
    card.focus();
    card.scrollIntoView({ block: "nearest" });
  }
}

function focusCard(id) {
  const index = state.items.findIndex((i) => i.id === id);
  if (index !== -1) focusCardByIndex(index);
}

// --- Event wiring -------------------------------------------------------------------
function bindEvents() {
  el.searchInput.addEventListener("input", () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      state.search = el.searchInput.value;
      loadItems({ reset: true });
    }, 150);
  });

  el.filterRow.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      el.filterRow.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      state.filter.type = chip.dataset.filterType;
      loadItems({ reset: true });
    });
  });

  el.tagFilter.addEventListener("change", () => {
    state.filter.tag = el.tagFilter.value;
    loadItems({ reset: true });
  });

  el.loadMoreBtn.addEventListener("click", () => loadItems({ reset: false }));

  el.imageModalClose.addEventListener("click", () => el.imageModal.close());
  el.imageModal.addEventListener("click", (e) => {
    if (e.target === el.imageModal) el.imageModal.close();
  });
  el.imageModal.addEventListener("close", () => {
    if (modalObjectUrl) {
      URL.revokeObjectURL(modalObjectUrl);
      modalObjectUrl = null;
    }
    el.imageModalImg.removeAttribute("src");
  });

  el.editTagsInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const value = el.editTagsInput.value.trim();
      if (value && !editingTags.includes(value)) {
        editingTags.push(value);
        renderEditTags();
      }
      el.editTagsInput.value = "";
    }
  });

  el.editCancel.addEventListener("click", () => el.editDialog.close());

  el.editForm.addEventListener("submit", async () => {
    if (!editingItem) return;
    const note = el.editNote.value.trim();
    const updated = await updateItem(editingItem.id, { note, tags: editingTags });
    const idx = state.items.findIndex((i) => i.id === updated.id);
    if (idx !== -1) state.items[idx] = updated;
    updateCardInPlace(updated);
    await refreshTagFilterOptions();
  });

  el.editDialog.addEventListener("close", () => {
    editingItem = null;
  });

  document.addEventListener("keydown", (e) => {
    const target = e.target;
    const isTyping =
      (target instanceof HTMLElement && target.matches("input, textarea, select")) ||
      (target instanceof HTMLElement && target.isContentEditable);

    if (e.key === "/" && !isTyping) {
      e.preventDefault();
      el.searchInput.focus();
      return;
    }

    if (e.key === "Escape") {
      if (document.activeElement === el.searchInput && el.searchInput.value) {
        el.searchInput.value = "";
        state.search = "";
        loadItems({ reset: true });
      }
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      return;
    }

    if (isTyping) return;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveFocus(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveFocus(-1);
        break;
      case "Enter":
        if (state.focusedIndex >= 0) openItem(state.items[state.focusedIndex].id);
        break;
      case "Delete":
      case "Backspace":
        if (state.focusedIndex >= 0) {
          e.preventDefault();
          deleteItemWithUndo(state.items[state.focusedIndex].id);
        }
        break;
      default:
        if (state.focusedIndex >= 0) {
          const key = e.key.toLowerCase();
          if (key === "f") {
            e.preventDefault();
            toggleFavorite(state.items[state.focusedIndex].id);
          } else if (key === "c") {
            e.preventDefault();
            copyItem(state.items[state.focusedIndex].id);
          } else if (key === "e") {
            // Opening the editor moves focus into the note textarea within this same keydown
            // dispatch, so the browser's default "insert character" action must be suppressed
            // or the "e" ends up typed into the field it just focused.
            e.preventDefault();
            openEditor(state.items[state.focusedIndex].id);
          }
        }
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === MESSAGE_TYPE.ITEM_SAVED) {
      loadItems({ reset: true });
      refreshTagFilterOptions();
    }
  });
}
