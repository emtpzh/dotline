import { useSyncExternalStore } from 'react';
import { API_BASE } from './constants';

// What a link's card says about the page behind it — its site, title, a
// line of description, the site's icon — and the small icon a link carries
// in the text.
//
// The card reads the page through the proxy's link snapshot (/api/fetch-url:
// the local proxy, the hosted functions and the harness plugin all answer
// it), parsed here as an inert document: DOMParser runs no script and loads
// nothing. It is asked only when a card opens, once per address per session;
// without a proxy (a static share) the card says what the address says.
//
// The icon in the text is the site's /favicon.ico, asked of the site itself
// the way an image in an answer is (no referrer); a page read for a card
// that names a better icon replaces it, and an icon that fails falls back
// to a glyph, once per address.

export interface LinkPreview {
  site?: string;
  title?: string;
  description?: string;
  icon?: string;
}

const previews = new Map<string, Promise<LinkPreview | null>>();

/** The page behind `url`, read once; null when it cannot be read. */
export function loadLinkPreview(url: string): Promise<LinkPreview | null> {
  let p = previews.get(url);
  if (!p) {
    p = readPreview(url).catch(() => null);
    previews.set(url, p);
  }
  return p;
}

// entities decoded, whitespace folded: a title the proxy cut out of raw HTML
const plain = (s: string): string =>
  (new DOMParser().parseFromString(s, 'text/html').documentElement.textContent ?? '').replace(/\s+/g, ' ').trim();

async function readPreview(url: string): Promise<LinkPreview | null> {
  const res = await fetch(`${API_BASE}/api/fetch-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { title?: string; html?: string; url?: string };
  if (!data.html) return data.title ? { title: plain(data.title) } : null;
  // the head is what a card reads; a long page's body is left alone
  const doc = new DOMParser().parseFromString(data.html.slice(0, 400_000), 'text/html');
  const meta = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = doc.querySelector(`meta[property="${k}"], meta[name="${k}"]`)?.getAttribute('content');
      if (v?.trim()) return v.replace(/\s+/g, ' ').trim();
    }
    return undefined;
  };
  const icon = pickIcon(doc, data.url || url);
  if (icon) betterIcon(hostOf(url), icon);
  const description = meta('og:description', 'description', 'twitter:description');
  return {
    site: meta('og:site_name', 'application-name'),
    title: meta('og:title', 'twitter:title') ?? (doc.title.replace(/\s+/g, ' ').trim() || (data.title ? plain(data.title) : undefined)),
    description: description && description.length > 280 ? `${description.slice(0, 279)}…` : description,
    icon,
  };
}

// The icon a page names for itself: an SVG first, then a raster of a size
// that reads small (32–96), then any, the touch icon last.
function pickIcon(doc: Document, base: string): string | undefined {
  const score = (l: Element): number => {
    const rel = (l.getAttribute('rel') ?? '').toLowerCase();
    const href = l.getAttribute('href') ?? '';
    const size = parseInt(l.getAttribute('sizes') ?? '', 10);
    let s = rel.includes('apple-touch-icon') ? -2 : 0;
    if ((l.getAttribute('type') ?? '').includes('svg') || /\.svg(\?|#|$)/i.test(href)) s += 3;
    if (size >= 32 && size <= 96) s += 2;
    else if (size > 96) s += 1;
    return s;
  };
  const links = Array.from(doc.querySelectorAll('link[rel][href]'))
    .filter((l) => /(^|\s)(icon|apple-touch-icon)(\s|$)/i.test(l.getAttribute('rel') ?? ''))
    .sort((a, b) => score(b) - score(a));
  for (const l of links) {
    try {
      const u = new URL(l.getAttribute('href') ?? '', base);
      if (u.protocol === 'https:' || u.protocol === 'http:' || /^data:image\//i.test(u.href)) return u.href;
    } catch { /* a malformed href: the next one */ }
  }
  return undefined;
}

/** The address's host, for icons; '' for one that is not a web address. */
export function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.host : '';
  } catch { return ''; }
}

/** The site, as a person names it: "zettelkasten.de", no "www." */
export const siteOf = (url?: string): string => (url ? hostOf(url).replace(/^www\./, '') : '');

/** A bare address shown short: the site, the path's first and last steps.
 *  "github.com/chenxiachan/…/ResponseSection.tsx" — the card has the rest. */
export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const steps = u.pathname.split('/').filter(Boolean);
    const path = steps.length <= 2 ? steps.join('/') : `${steps[0]}/…/${steps[steps.length - 1]}`;
    const s = path ? `${u.host.replace(/^www\./, '')}/${path}` : u.host.replace(/^www\./, '');
    return s.length > 56 ? `${s.slice(0, 55)}…` : s;
  } catch { return url; }
}

// ── the icons in the text ──
const better = new Map<string, string>(); // host → the icon its page names
const broken = new Set<string>();         // icon addresses that failed to load
let version = 0;
const listeners = new Set<() => void>();
const changed = () => { version++; listeners.forEach((fn) => fn()); };
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

function betterIcon(host: string, icon: string): void {
  if (!host || better.get(host) === icon) return;
  better.set(host, icon);
  changed();
}

/** An icon that failed: the links on its site move to the next one. */
export function iconFailed(src: string): void {
  if (broken.has(src)) return;
  broken.add(src);
  changed();
}

/** The icon to show for `url` now, or null for the glyph. */
export function useSiteIcon(url: string): string | null {
  useSyncExternalStore(subscribe, () => version);
  const host = hostOf(url);
  if (!host) return null;
  const protocol = url.startsWith('http:') ? 'http:' : 'https:';
  for (const src of [better.get(host), `${protocol}//${host}/favicon.ico`]) {
    if (src && !broken.has(src)) return src;
  }
  return null;
}
