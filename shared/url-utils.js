export function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function buildTextFragmentUrl(url, snippet) {
  if (!snippet) return url;
  try {
    const u = new URL(url);
    const trimmed = snippet.trim().slice(0, 300);
    if (!trimmed) return url;
    u.hash = `:~:text=${encodeURIComponent(trimmed)}`;
    return u.toString();
  } catch {
    return url;
  }
}

export async function fetchFaviconBlob(favIconUrl) {
  if (!favIconUrl) return null;
  try {
    const res = await fetch(favIconUrl);
    if (!res.ok) return null;
    return await res.blob();
  } catch {
    return null;
  }
}

export function buildSearchBlob({ title, url, domain, textContent, note, tags }) {
  return [title, url, domain, textContent, note, ...(tags || [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}
