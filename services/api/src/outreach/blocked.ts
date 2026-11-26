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
const IG_URL_IN_TEXT = /https?:\/\/(?:www\.)?instagram\.com\/[^\s<>()[\]"',;]+/gi;
const IG_HANDLE_IN_TEXT = /(?:^|[^A-Za-z0-9._%+-])@([A-Za-z0-9._]{1,30})(?=$|[^A-Za-z0-9._])/g;

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
  for (const url of text.match(IG_URL_IN_TEXT) ?? []) {
    if (isInstagramClosed(url, closed)) return true;
  }
  for (const match of text.matchAll(IG_HANDLE_IN_TEXT)) {
    const handle = match[1];
    if (handle && isInstagramClosed(handle, closed)) return true;
  }
  return false;
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
    for (const url of flag.text.match(IG_URL_IN_TEXT) ?? []) {
      const handle = instagramHandle(url);
      if (handle) instagram.add(`I#@${handle.toLowerCase()}`);
    }
    for (const match of flag.text.matchAll(IG_HANDLE_IN_TEXT)) {
      const handle = instagramHandle(match[1]);
      if (handle) instagram.add(`I#@${handle.toLowerCase()}`);
    }
  }
  return { emails, numbers, instagram };
}

export function isBlockedTarget(blocked: BlockedValues, target: Pick<ProspectRoute, "channel" | "to">): boolean {
  if (target.channel === "email") return blocked.emails.has(target.to.toLowerCase());
  if (target.channel === "instagram") return blocked.instagram.has(instagramKey(target.to));
  return (target.channel === "whatsapp" || target.channel === "call") && blocked.numbers.has(numberKey(target.to));
}
