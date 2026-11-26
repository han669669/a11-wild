import type { ProspectFlag, ProspectRoute } from "@a11-wild/shared";

export interface BlockedValues {
  emails: Set<string>;
  numbers: Set<string>;
}

const digits = (value: string): string => value.replace(/\D/g, "");
export const numberKey = (value: string): string => {
  const found = digits(value);
  return found.length === 8 ? `65${found}` : found;
};

/** Canonical opt-out key for an Instagram handle or profile URL (`I#@handle`). */
export const instagramKey = (value: string): string => {
  const trimmed = value.trim();
  const urlMatch = trimmed.match(/^https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9._]{1,30})(?:\/|\?|$)/i);
  const handle = urlMatch ? urlMatch[1]! : trimmed.replace(/^@/, "");
  return `I#@${handle.toLowerCase()}`;
};

export const EMAIL_ADDRESS = /^[^\s<>()[\]"',;:|@]+@[^\s<>()[\]"',;:|\x2f@]+\.[a-z]{2,}$/i;
export const EMAIL_IN_TEXT = /[^\s<>()[\]"',;:|@]+@[^\s<>()[\]"',;:|\x2f@]+\.[a-z]{2,}/gi;

export function blockedValues(flags: ProspectFlag[]): BlockedValues {
  const emails = new Set<string>();
  const numbers = new Set<string>();
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
  }
  return { emails, numbers };
}

export function isBlockedTarget(blocked: BlockedValues, target: Pick<ProspectRoute, "channel" | "to">): boolean {
  if (target.channel === "email") return blocked.emails.has(target.to.toLowerCase());
  return (target.channel === "whatsapp" || target.channel === "call") && blocked.numbers.has(numberKey(target.to));
}
