// The brand's own logo from the home page HTML. Pure module.
// Ported from ai-ad-generator `convex/lib/logoHtml.ts`, where each rule was added after a real brand failed
// (Love, Bonito, Allies of Skin, ErgoTune, Our Place, Bacha, Prefer, IRVINS, Gryphon Tea).
// Difference: an inline SVG is only detected here, never stored. brand_extract reports it, and the owner supplies the file.

export type HeaderLogo = { kind: "img"; url: string } | { kind: "svg" };
export type HeaderLogoCandidate = { kind: "img"; url: string; fallbacks?: string[] } | { kind: "svg" };

/** Largest inline SVG looked at (a wordmark is a few KB; a 200 KB SVG is an illustration). */
const SVG_MAX_CHARS = 200_000;
/** How much of the page counts as the header when the page has no <header> element. */
const HEAD_CHARS = 250_000;

const attr = (tag: string, name: string): string | undefined => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? (m[2] ?? m[3] ?? m[4] ?? "").trim() : undefined;
};

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/** True when a link points at the site's home page: "/", the origin, or a locale root such as "/sg" or "/en-us/". */
function isHomeLink(href: string | undefined, pageUrl: string): boolean {
  // A link with a fragment ("#", "/en/#") is an in-page button (a menu, a cart, a country picker), not a home link.
  // Rendered HTML writes href="#" as an absolute URL ("https://bachacoffee.com/en/#"), so the test is on the whole href.
  if (href === undefined || /#|^\s*$|^\s*javascript:/i.test(href)) return false;
  try {
    const page = new URL(pageUrl);
    const u = new URL(decode(href), page);
    if (u.host !== page.host) return false;
    const path = u.pathname.replace(/\/+$/, "");
    return path === "" || /^\/[a-z]{2}(?:[-_][a-z]{2})?$/i.test(path);
  } catch {
    return false;
  }
}

/** The element at `start` up to its matching close tag (nested tags of the same name counted), or "" when it does not close. */
function balanced(html: string, start: number, name: string): string {
  const re = new RegExp(`<(/?)${name}\\b[^>]*?(/?)>`, "gi");
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[1]) depth--;
    else if (!m[2]) depth++;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
    if (m.index - start > SVG_MAX_CHARS) return "";
  }
  return "";
}

/** True when an inline SVG draws something of its own: it has a shape, and no <use> that points at a symbol outside it (an icon sprite). */
function drawsItself(svg: string): boolean {
  if (!svg || svg.length > SVG_MAX_CHARS) return false;
  for (const m of svg.matchAll(/<use\b[^>]*(?:xlink:)?href\s*=\s*["']([^"']+)["']/gi)) {
    const ref = m[1]!;
    if (!ref.startsWith("#")) return false; // "/icons.svg#menu" is a sprite file
    const id = ref.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`\\sid\\s*=\\s*["']${id}["']`).test(svg)) return false;
  }
  return /<(path|polygon|rect|circle|ellipse|text|g|use|polyline)\b/i.test(svg);
}

/** True when an SVG names itself a logo in its class, id, label, test id or <title>. */
const svgNamesLogo = (svg: string) => {
  const open = svg.match(/^<svg\b[^>]*>/i)?.[0] ?? "";
  const title = svg.match(/<title\b[^>]*>([^<]*)</i)?.[1] ?? "";
  return /logo|brand|wordmark/.test(["class", "id", "aria-label", "data-testid"].map((a) => attr(open, a) ?? "").join(" ").concat(" ", title).toLowerCase());
};

/** UI icon names that are never a brand logo, as they appear in icon classes, ids and labels. */
const UI_ICON = /(^|[^a-z])(icon|lucide|check(mark)?|cart|bag|basket|search|menu|hamburger|close|arrow|chevron|caret|account|user|heart|wishlist|plus|minus|globe|flag)([^a-z]|$)/;
/** Largest viewBox side (in user units) of an unlabelled SVG that counts as an icon: icon sets draw on 24 units or less. */
const ICON_MAX_UNITS = 24;

/** True when an inline SVG is a UI icon: its own class, id or label names an icon and not a logo, or it has no logo label and an icon-sized viewBox. */
export function isUiIconSvg(svg: string): boolean {
  const open = svg.match(/^<svg\b[^>]*>/i)?.[0] ?? "";
  const title = svg.match(/<title\b[^>]*>([^<]*)</i)?.[1] ?? "";
  const label = ["class", "id", "aria-label", "data-testid"].map((a) => attr(open, a) ?? "").join(" ").concat(" ", title).toLowerCase();
  if (svgNamesLogo(svg)) return false;
  if (UI_ICON.test(label)) return true;
  const vb = (attr(open, "viewBox") ?? attr(open, "viewbox") ?? "").split(/[\s,]+/).map(Number);
  return vb.length === 4 && vb[2]! > 0 && vb[3]! > 0 && vb[2]! <= ICON_MAX_UNITS && vb[3]! <= ICON_MAX_UNITS;
}

/** The path of an image URL, decoded and lower case: its folders and file ("…/country-flag-images/united-states.svg"). */
const imagePath = (url: string) => {
  try {
    const p = new URL(url).pathname;
    try {
      return decodeURIComponent(p).toLowerCase();
    } catch {
      return p.toLowerCase();
    }
  } catch {
    return "";
  }
};

/** True when a header <img> is a UI icon: its class, id, alt, title, test id or label, or a folder or file name of its path, names an icon. A name with "logo", "brand" or "wordmark" is never an icon. */
export function isUiIconImg(img: string, url: string): boolean {
  const label = ["class", "id", "alt", "aria-label", "title", "data-testid"].map((a) => attr(img, a) ?? "").join(" ").toLowerCase();
  const path = imagePath(url);
  if (/logo|brand|wordmark/.test(`${label} ${path}`)) return false;
  return UI_ICON.test(label) || UI_ICON.test(path);
}

/** Most words a label (alt, aria-label, title) may have besides the brand name and still name the logo ("Our Place logo"). */
const BRAND_LABEL_EXTRA_WORDS = 3;

/**
 * A logo container: a link to the home page, a tag whose class, id, label, alt, title or test id names a logo, or a tag that names the brand.
 * A class, id or test id may hold the brand anywhere ("ourplace-logo"); an alt, aria-label or title names the brand only when it is short,
 * because a product photo's alt text often names the brand.
 */
function isLogoTag(tag: string, pageUrl: string, brand: string): boolean {
  const name = tag.match(/^<([a-z0-9-]+)/i)?.[1]?.toLowerCase() ?? "";
  if (name === "a" && isHomeLink(attr(tag, "href"), pageUrl)) return true;
  const label = ["class", "id", "aria-label", "alt", "title", "data-testid"].map((a) => attr(tag, a) ?? "").join(" ").toLowerCase();
  if (/(^|[^a-z])logo/.test(label)) return true;
  const brandWords = brand.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const b = brandWords.join("");
  if (b.length < 3) return false;
  const names = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, "").includes(b);
  if (["class", "id", "data-testid"].some((a) => names(attr(tag, a) ?? ""))) return true;
  return ["aria-label", "alt", "title"].some((a) => {
    const v = attr(tag, a) ?? "";
    return names(v) && (v.match(/[a-z0-9]+/gi) ?? []).length <= brandWords.length + BRAND_LABEL_EXTRA_WORDS;
  });
}

/**
 * The logos in the page header, best first (at most 2): the first inline SVG or image inside a logo container,
 * along with lower-resolution fallback URLs from the same <img> tag when available.
 */
export function headerLogoCandidates(html: string, pageUrl: string, brand: string): HeaderLogoCandidate[] {
  const headers = [...html.matchAll(/<header\b[\s\S]*?<\/header\s*>/gi)].map((m) => m[0]);
  const inHeaders = headers.length ? logosIn(headers.join("\n"), pageUrl, brand) : [];
  return inHeaders.length ? inHeaders : logosIn(html.slice(0, HEAD_CHARS), pageUrl, brand);
}

/**
 * The logos in the page header, best first (at most 2): the first inline SVG or image inside a logo container.
 * The header is every <header> element of the page; when they hold none, the start of the page.
 */
export function headerLogos(html: string, pageUrl: string, brand: string): HeaderLogo[] {
  return headerLogoCandidates(html, pageUrl, brand).map((l) => (l.kind === "img" ? { kind: "img", url: l.url } : l));
}

/** Widest logo entry picked from a srcset when larger sizes exist. */
const LOGO_SRCSET_MAX_W = 2000;

type SrcsetEntry = { href: string; kind: "w" | "x" | "direct" | "none"; value: number };

/** Parse an HTML srcset attribute per the image candidate string syntax, preserving commas inside URLs and compact comma separators after descriptors. */
function parseSrcset(srcset: string): SrcsetEntry[] {
  const s = decode(srcset);
  const out: SrcsetEntry[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    while (i < n && /[\s,]/.test(s[i]!)) i++;
    if (i >= n) break;
    const urlStart = i;
    while (i < n && !/\s/.test(s[i]!)) i++;
    let href = s.slice(urlStart, i);
    // A trailing comma with no descriptor ends this candidate.
    if (href.endsWith(",")) {
      href = href.replace(/,+$/, "");
      if (href && !href.startsWith("data:")) out.push({ href, kind: "none", value: 0 });
      continue;
    }
    while (i < n && /\s/.test(s[i]!)) i++;
    const descStart = i;
    while (i < n && s[i] !== ",") i++;
    const desc = s.slice(descStart, i).trim();
    if (i < n && s[i] === ",") i++;
    if (!href || href.startsWith("data:")) continue;
    const w = desc.match(/^(\d+)w$/i);
    if (w) out.push({ href, kind: "w", value: Number.parseInt(w[1]!, 10) });
    else {
      const x = desc.match(/^(\d+(?:\.\d+)?)x$/i);
      if (x) out.push({ href, kind: "x", value: Number.parseFloat(x[1]!) });
      else out.push({ href, kind: "none", value: 0 });
    }
  }
  return out;
}

/** Rank parsed candidate entries best-first: widest <= 2000w, then smallest > 2000w, then highest x density, then direct attributes, then remaining reversed. */
function rankCandidates(entries: SrcsetEntry[]): string[] {
  if (!entries.length) return [];
  const widths = entries.filter((e) => e.kind === "w");
  const fits = widths.filter((e) => e.value <= LOGO_SRCSET_MAX_W).sort((a, b) => b.value - a.value);
  const over = widths.filter((e) => e.value > LOGO_SRCSET_MAX_W).sort((a, b) => a.value - b.value);
  const densities = entries.filter((e) => e.kind === "x").sort((a, b) => b.value - a.value);
  const direct = entries.filter((e) => e.kind === "direct");
  const rest = entries.filter((e) => e.kind === "none").reverse();
  return [...fits, ...over, ...densities, ...direct, ...rest].map((e) => e.href);
}

/** Pick the highest-resolution usable entry from a srcset attribute (ignoring data: URIs). */
export function largestSrcset(srcset: string | undefined): string | undefined {
  return srcset ? rankCandidates(parseSrcset(srcset))[0] : undefined;
}

const HARD_PLACEHOLDER = /(?:^|\/)(blank|placeholder|spacer|pixel|1x1|loading)\.[a-z0-9]+(?:[?#]|$)/i;
const LAZY_HINT_SRC = /(?:^|\/)(blank|placeholder|spacer|transparent|pixel|1x1|loading)\.[a-z0-9]+(?:[?#]|$)/i;

function urlWidth(raw: string): number | undefined {
  const m = /[?&](?:width|w)=(\d+)\b/i.exec(decode(raw));
  return m ? Number.parseInt(m[1]!, 10) : undefined;
}

/** Ordered image addresses from an <img> tag, best-first: widest usable source first across srcset, data-srcset, src and data-src. */
export function imgSrcCandidates(imgTag: string): string[] {
  const src = attr(imgTag, "src");
  const dataSrc = attr(imgTag, "data-src");
  const srcsetRaw = attr(imgTag, "srcset");
  const dataSrcsetRaw = attr(imgTag, "data-srcset");
  const srcsetEntries = [...(srcsetRaw ? parseSrcset(srcsetRaw) : []), ...(dataSrcsetRaw ? parseSrcset(dataSrcsetRaw) : [])];
  const srcIsEmpty = !src || src.startsWith("data:");
  const srcIsHardPlaceholder = !!src && HARD_PLACEHOLDER.test(src);
  const srcIsLazyHint = !!src && LAZY_HINT_SRC.test(src);
  const isRasterAlt = (u: string | undefined) => !!u && !u.startsWith("data:") && !/\.svg(?:[?#]|$)/i.test(decode(u));
  const hasRasterAlt = isRasterAlt(dataSrc) || srcsetEntries.some((e) => isRasterAlt(e.href));
  const isLazy = !!dataSrc && (srcIsEmpty || /\blazyload\b/i.test(attr(imgTag, "class") ?? "") || srcIsLazyHint);
  const usableSrc = srcIsHardPlaceholder && hasRasterAlt ? undefined : src;
  const preferredDirect = isLazy ? dataSrc : usableSrc;
  const otherDirect = isLazy ? usableSrc : dataSrc;
  const toDirectEntry = (href: string | undefined, allowWidth: boolean): SrcsetEntry[] => {
    if (!href || href.startsWith("data:")) return [];
    const w = allowWidth ? urlWidth(href) : undefined;
    return w ? [{ href, kind: "w", value: w }] : [{ href, kind: "direct", value: 0 }];
  };
  const hasWidthSrcset = srcsetEntries.some((e) => e.kind === "w");
  // Keep at most the top 3 srcset variants alongside direct src/data-src so large srcsets never crowd out direct fallbacks.
  const topSrcset = rankCandidates(srcsetEntries).slice(0, 3);
  const topSrcsetEntries = srcsetEntries.filter((e) => topSrcset.includes(e.href));
  const ranked = rankCandidates([
    ...topSrcsetEntries,
    ...toDirectEntry(preferredDirect, hasWidthSrcset),
    ...toDirectEntry(otherDirect, false),
  ]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of ranked) {
    if (!item || item.startsWith("data:") || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/** Pick the highest-resolution image address from an <img> tag, preferring srcset over thumbnail src. */
export function bestImgSrc(imgTag: string): string | undefined {
  return imgSrcCandidates(imgTag)[0];
}

function logosIn(region: string, pageUrl: string, brand: string): HeaderLogoCandidate[] {
  const out: HeaderLogoCandidate[] = [];
  const seen = new Set<string>();
  const byPrimary = new Map<string, { kind: "img"; url: string; fallbacks?: string[] }>();
  for (const m of region.matchAll(/<(a|div|span|figure|picture|svg|img|h1|p)\b[^>]*>/gi)) {
    if (out.length >= 2) break;
    const tag = m[0];
    if (!isLogoTag(tag, pageUrl, brand)) continue;
    const at = m.index ?? 0;
    const name = m[1]!.toLowerCase();
    // The logo itself, or the first SVG or image inside the container element (never past its close tag).
    const scope = name === "img" ? tag : name === "svg" ? balanced(region, at, "svg") : balanced(region, at, name).slice(0, 8_000);
    // A decorative SVG before the wordmark does not hide the wordmark: each drawable is tried in page order, the first that passes is the logo.
    const svgCount = (scope.match(/<svg\b/gi) ?? []).length;
    let pos = 0;
    while (pos < scope.length) {
      const rest = scope.slice(pos);
      const svgAt = rest.search(/<svg\b/i);
      const imgAt = rest.search(/<img\b/i);
      if (svgAt < 0 && imgAt < 0) break;
      if (svgAt >= 0 && (imgAt < 0 || svgAt < imgAt)) {
        const first = balanced(scope, pos + svgAt, "svg");
        pos += svgAt + Math.max(first.length, 4);
        // A box (not a link) with several SVGs is a picture made of parts: one unnamed part is not the logo (IRVINS mascot).
        if (name !== "a" && name !== "svg" && svgCount >= 2 && !svgNamesLogo(first)) continue;
        if (drawsItself(first) && !isUiIconSvg(first) && !seen.has(first)) {
          seen.add(first);
          out.push({ kind: "svg" });
          break;
        }
      } else {
        const img = rest.slice(imgAt).match(/^<img\b[^>]*>/i)?.[0] ?? "";
        pos += imgAt + Math.max(img.length, 4);
        // Prefer the largest srcset entry over thumbnail src; keep lower-res candidates as fallbacks in case a srcset entry is dead.
        const urls: string[] = [];
        for (const raw of imgSrcCandidates(img)) {
          try {
            const url = new URL(decode(raw), pageUrl).toString();
            if (/^https?:/.test(url) && !/\.ico(\?|$)/i.test(url) && !isUiIconImg(img, url) && !urls.includes(url)) {
              urls.push(url);
            }
          } catch {
            continue;
          }
        }
        const [primary, ...fallbacks] = urls;
        if (primary) {
          const existing = byPrimary.get(primary);
          if (existing) {
            const extra = fallbacks.filter((u) => u !== existing.url && !existing.fallbacks?.includes(u));
            if (extra.length) existing.fallbacks = [...(existing.fallbacks ?? []), ...extra];
          } else {
            const entry: { kind: "img"; url: string; fallbacks?: string[] } = fallbacks.length ? { kind: "img", url: primary, fallbacks } : { kind: "img", url: primary };
            byPrimary.set(primary, entry);
            out.push(entry);
          }
          break;
        }
      }
    }
  }
  return out;
}

const jsonLdBlocks = (html: string): unknown[] =>
  [...html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)].flatMap((m) => {
    try {
      const v: unknown = JSON.parse(m[1]!);
      const list = Array.isArray(v) ? v : [v];
      return list.flatMap((x) => (x && typeof x === "object" && Array.isArray((x as { "@graph"?: unknown })["@graph"]) ? (x as { "@graph": unknown[] })["@graph"] : [x]));
    } catch {
      return [];
    }
  });

type Org = { name?: string | undefined; logo?: string | undefined };
function organization(html: string): Org {
  let name: string | undefined;
  for (const b of jsonLdBlocks(html)) {
    if (!b || typeof b !== "object") continue;
    const o = b as Record<string, unknown>;
    const types = ([] as unknown[]).concat(o["@type"] ?? []);
    if (!types.some((t) => t === "Organization" || t === "Brand" || t === "Store" || t === "OnlineStore")) continue;
    const l = o.logo && typeof o.logo === "object" ? (o.logo as { url?: unknown; contentUrl?: unknown }) : undefined;
    const logo = l ? (typeof l.url === "string" && l.url ? l.url : l.contentUrl) : o.logo;
    name ??= typeof o.name === "string" && o.name.trim() ? o.name.trim() : undefined;
    // A node with no usable logo does not stop the search: a later Organization in the same graph may hold it.
    if (typeof logo === "string" && logo) return { name, logo };
  }
  return { name };
}

/** The site's own brand name: og:site_name, else the JSON-LD Organization name, else the start of the title. "" when none. */
export function siteName(html: string): string {
  const og = html.match(/<meta\b[^>]*property\s*=\s*["']og:site_name["'][^>]*>/i)?.[0];
  const ogName = og ? decode(attr(og, "content") ?? "") : "";
  const title = decode(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const candidates = [ogName, organization(html).name ?? "", title.split(/\s[|\-–—]\s|\s?[|–—]\s?/)[0] ?? ""];
  // A bracketed store or region note is not part of the name ("ALLIES [North America]").
  return candidates.map((c) => c.replace(/\s*[[(][^\])]*[\])]\s*/g, " ").replace(/\s+/g, " ").trim()).find((c) => c.length >= 2 && c.length <= 60) ?? "";
}

/** The JSON-LD Organization logo URL, resolved against the page; undefined when there is none. */
export function organizationLogo(html: string, pageUrl: string): string | undefined {
  const logo = organization(html).logo;
  if (!logo) return undefined;
  try {
    const u = new URL(logo, pageUrl).toString();
    return /^https?:/.test(u) ? u : undefined;
  } catch {
    return undefined;
  }
}

/** One key per image file: a CDN lists the same logo at many sizes (`?width=500`, `?width=600`). */
export const fileKey = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.toLowerCase();
  } catch {
    return url;
  }
};
