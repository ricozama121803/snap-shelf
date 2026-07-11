export const DB_NAME = "SnapShelfDB";
export const DB_VERSION = 1;
export const STORE_ITEMS = "items";

export const ITEM_TYPE = {
  TEXT: "text",
  SCREENSHOT: "screenshot",
  IMAGE: "image",
};

export const CONTEXT_MENU_ID = {
  SAVE_SELECTION: "snapshelf-save-selection",
  SAVE_IMAGE: "snapshelf-save-image",
  CAPTURE_REGION: "snapshelf-capture-region",
};

export const COMMAND_ID = {
  START_REGION_CAPTURE: "start-region-capture",
};

export const MESSAGE_TYPE = {
  REGION_SELECTED: "REGION_SELECTED",
  CROP_AND_ENCODE: "CROP_AND_ENCODE",
  FETCH_AND_ENCODE_IMAGE: "FETCH_AND_ENCODE_IMAGE",
  ITEM_SAVED: "ITEM_SAVED",
};

export const WEBP_QUALITY = 0.8;
