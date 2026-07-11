(() => {
  // Guard against double-injection (e.g. action clicked twice before the first overlay finishes).
  if (document.getElementById("snapshelf-overlay-root")) return;

  const MIN_SIZE = 4;

  const root = document.createElement("div");
  root.id = "snapshelf-overlay-root";

  const box = document.createElement("div");
  box.id = "snapshelf-selection-box";

  const hint = document.createElement("div");
  hint.id = "snapshelf-hint";
  hint.innerHTML = 'Drag to select an area to save &nbsp;&bull;&nbsp; <kbd>Esc</kbd> to cancel';

  root.appendChild(box);
  root.appendChild(hint);
  document.documentElement.appendChild(root);

  let startX = 0;
  let startY = 0;
  let dragging = false;

  function cleanup() {
    document.removeEventListener("keydown", onKeyDown, true);
    root.removeEventListener("mousedown", onMouseDown);
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
    root.remove();
  }

  function onKeyDown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
    }
  }

  function onMouseDown(e) {
    if (e.button !== 0) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    box.style.display = "block";
    updateBox(startX, startY, startX, startY);
    e.preventDefault();
  }

  function onMouseMove(e) {
    if (!dragging) return;
    updateBox(startX, startY, e.clientX, e.clientY);
  }

  function onMouseUp(e) {
    if (!dragging) return;
    dragging = false;

    const rect = {
      x: Math.min(startX, e.clientX),
      y: Math.min(startY, e.clientY),
      width: Math.abs(e.clientX - startX),
      height: Math.abs(e.clientY - startY),
    };

    cleanup();

    if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) {
      return;
    }

    chrome.runtime.sendMessage({
      type: "REGION_SELECTED",
      rect,
      devicePixelRatio: window.devicePixelRatio || 1,
    });
  }

  function updateBox(x1, y1, x2, y2) {
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${Math.abs(x2 - x1)}px`;
    box.style.height = `${Math.abs(y2 - y1)}px`;
  }

  document.addEventListener("keydown", onKeyDown, true);
  root.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);
})();
