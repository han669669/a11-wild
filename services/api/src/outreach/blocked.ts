import type { ProspectFlag, ProspectRoute } from "@a11-wild/shared";

export interface BlockedValues {
  emails: Set<string>;
  numbers: Set<string>;
  instagram: Set<string>;
}

const digits = (value: string): string => value.replace(/\D/g, "");
export const numberKey = (value: string): string => {
  const found = digits(value);
  return found.length === 8 ? `65${found}` : found;
};

const IG_HANDLE = /^[A-Za-z0-9._]{1,30}$/;
const IG_RESERVED = new Set([
  "p",
  "reel",
  "reels",
  "stories",
  "explore",
  "accounts",
  "direct",
  "tv",
  "tags",
  "locations",
  "about",
  "legal",
  "developer",
  "privacy",
  "terms",
  "directory",
  "lite",
  "web",
  "api",
  "graphql",
  "oauth",
  "challenge",
  "session",
]);
export const IG_URL_IN_TEXT = /(?:^|[^A-Za-z0-9.-])((?:https?:\/\/)?(?:www\.)?instagram\.com\/[^\s<>()[\]"',;]+)/gi;
export const IG_HANDLE_IN_TEXT = /(?:^|[^A-Za-z0-9._%+-])@([A-Za-z0-9._]{1,30})(?=$|[^A-Za-z0-9._])/g;

const trimUrlPunctuation = (value: string): string => value.replace(/[.,;!?]+$/, "");
const trimHandleDots = (value: string): string => value.replace(/\.+$/, "");

/** Extracts a canonical Instagram handle (without leading `@`) from a bare handle or single-profile URL. Rejects post/reel/multi-segment links. */
export const instagramHandle = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^(?:https?:\/\/|www\.instagram\.com\/|instagram\.com\/)/i.test(trimmed)) {
    try {
      const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
      if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
      if (url.hostname.toLowerCase() !== "instagram.com" && url.hostname.toLowerCase() !== "www.instagram.com") return undefined;
      const segments = url.pathname.split("/").filter(Boolean);
      if (segments.length !== 1) return undefined;
      const handle = segments[0]!;
      if (!IG_HANDLE.test(handle) || handle === "." || handle === ".." || IG_RESERVED.has(handle.toLowerCase())) return undefined;
      return handle;
    } catch {
      return undefined;
    }
  }
  const handle = trimmed.replace(/^@/, "");
  if (!IG_HANDLE.test(handle) || handle === "." || handle === "..") return undefined;
  return handle;
};

/** Canonical opt-out key for an Instagram handle or profile URL (`I#@handle`), or exact lowercase fallback for non-profile values. */
export const instagramKey = (value: string): string => {
  const handle = instagramHandle(value);
  return handle ? `I#@${handle.toLowerCase()}` : `I#${value.trim().toLowerCase()}`;
};

/** True when `value` matches any Instagram opt-out key in `closed`, including pre-upgrade raw URL or bare-handle keys. */
export const isInstagramClosed = (value: string, closed: ReadonlySet<string>): boolean => {
  const trimmed = value.trim();
  if (!trimmed || closed.size === 0) return false;
  const canonical = instagramKey(trimmed);
  if (closed.has(canonical) || closed.has(`I#${trimmed.toLowerCase()}`)) return true;
  const handle = instagramHandle(trimmed)?.toLowerCase();
  if (!handle) return false;
  for (const key of closed) {
    if (!key.startsWith("I#")) continue;
    if (instagramHandle(key.slice(2))?.toLowerCase() === handle) return true;
  }
  return false;
};

/** True when free text mentions an opted-out Instagram handle (`@handle`) or profile URL (`instagram.com/handle`). */
export const textShowsClosedInstagram = (text: string, closed: ReadonlySet<string>): boolean => {
  if (!text || closed.size === 0) return false;
  for (const match of text.matchAll(IG_URL_IN_TEXT)) {
    const url = trimUrlPunctuation(match[1] ?? "");
    if (url && isInstagramClosed(url, closed)) return true;
  }
  for (const match of text.matchAll(IG_HANDLE_IN_TEXT)) {
    const raw = match[1];
    const trimmed = raw ? trimHandleDots(raw) : "";
    if ((raw && isInstagramClosed(raw, closed)) || (trimmed && isInstagramClosed(trimmed, closed))) return true;
  }
  return false;
};

/** Removes any Instagram profile URL or `@handle` matching `hidden` from a text segment. */
export const scrubInstagramText = (segment: string, hidden: ReadonlySet<string>): string => {
  if (!segment || hidden.size === 0) return segment;
  return segment
    .replace(IG_URL_IN_TEXT, (match, rawUrl: string) => {
      const url = trimUrlPunctuation(rawUrl);
      const suffix = rawUrl.slice(url.length);
      if (!url || !isInstagramClosed(url, hidden)) return match;
      return match.slice(0, match.length - rawUrl.length) + suffix;
    })
    .replace(IG_HANDLE_IN_TEXT, (match, raw: string) => {
      const trimmed = trimHandleDots(raw);
      const dots = raw.slice(trimmed.length);
      const closed = isInstagramClosed(raw, hidden) || (trimmed !== "" && isInstagramClosed(trimmed, hidden));
      if (!closed) return match;
      return match.slice(0, match.indexOf("@")) + (isInstagramClosed(raw, hidden) ? "" : dots);
    })
    .replace(/\s{2,}/g, " ")
    .trim();
};

/** Scrubs quarantined Instagram mentions from a surviving non-social route's label and note. */
export const scrubRouteInstagram = (route: ProspectRoute, hidden: ReadonlySet<string>): ProspectRoute => {
  if (hidden.size === 0) return route;
  const label = scrubInstagramText(route.label, hidden).replace(/\(\s*\)/g, "").replace(/\s{2,}/g, " ").trim() || route.label;
  const note = route.note ? scrubInstagramText(route.note, hidden) || undefined : undefined;
  const { note: _oldNote, ...rest } = route;
  return { ...rest, label, ...(note ? { note } : {}) };
};

export const EMAIL_ADDRESS = /^[^\s<>()[\]"',;:|@]+@[^\s<>()[\]"',;:|\x2f@]+\.[a-z]{2,}$/i;
export const EMAIL_IN_TEXT = /[^\s<>()[\]"',;:|@]+@[^\s<>()[\]"',;:|\x2f@]+\.[a-z]{2,}/gi;

export function blockedValues(flags: ProspectFlag[]): BlockedValues {
  const emails = new Set<string>();
  const numbers = new Set<string>();
  const instagram = new Set<string>();
  for (const flag of flags) {
    if (flag.kind !== "blocked") continue;
    for (const found of flag.text.match(EMAIL_IN_TEXT) ?? []) {
      emails.add(found.toLowerCase());
      for (const piece of found.split("/")) if (EMAIL_ADDRESS.test(piece)) emails.add(piece.toLowerCase());
    }
    for (const found of flag.text.match(/\+?\d[\d().\s-]{5,}\d/g) ?? []) {
      const key = numberKey(found);
      if (key.length >= 8) numbers.add(key);
    }
    for (const match of flag.text.matchAll(IG_URL_IN_TEXT)) {
      const rawUrl = match[1] ?? "";
      for (const candidate of [rawUrl, trimUrlPunctuation(rawUrl)]) {
        const handle = instagramHandle(candidate);
        if (handle) instagram.add(`I#@${handle.toLowerCase()}`);
      }
    }
    for (const match of flag.text.matchAll(IG_HANDLE_IN_TEXT)) {
      const raw = match[1] ?? "";
      for (const candidate of [raw, trimHandleDots(raw)]) {
        const handle = instagramHandle(candidate);
        if (handle) instagram.add(`I#@${handle.toLowerCase()}`);
      }
    }
  }
  return { emails, numbers, instagram };
}

export function isBlockedTarget(blocked: BlockedValues, target: Pick<ProspectRoute, "channel" | "to">): boolean {
  if (target.channel === "email") return blocked.emails.has(target.to.toLowerCase());
  if (target.channel === "instagram") return blocked.instagram.has(instagramKey(target.to));
  return (target.channel === "whatsapp" || target.channel === "call") && blocked.numbers.has(numberKey(target.to));
}
