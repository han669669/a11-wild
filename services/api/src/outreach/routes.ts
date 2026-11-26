import type { ProspectRoute } from "@a11-wild/shared";
import { EMAIL_IN_TEXT, numberKey } from "./blocked.js";
import { address, numbers } from "./load.js";

const EMAIL_IN_NOTE = new RegExp(EMAIL_IN_TEXT.source, EMAIL_IN_TEXT.flags.replace("g", ""));
const PHONE_IN_NOTE = /\+?\d[\d().\s-]{5,}\d/;
const PHONE_CANDIDATE = /\+?\d(?:[\d\s-]|\(\d+\))*(?:\d|\(\d+\))/g;
const PHONE_ROUTE_LABEL = /^(DM phone|Phone|WhatsApp)\s+(.+)$/i;

export const trailingBracketGroup = (value: string): { prefix: string; content: string } | undefined => {
  if (!value.endsWith(")")) return undefined;
  let depth = 0;
  let opening = -1;
  for (let i = value.length - 1; i >= 0; i -= 1) {
    if (value[i] === ")") depth += 1;
    else if (value[i] === "(") {
      depth -= 1;
      if (depth === 0) {
        opening = i;
        break;
      }
    }
  }
  if (opening <= 0 || !/\s/.test(value[opening - 1]!)) return undefined;
  return { prefix: value.slice(0, opening).trimEnd(), content: value.slice(opening + 1, -1).trim() };
};

export function hasUnbalancedBrackets(value: string): boolean {
  let depth = 0;
  for (const character of value) {
    if (character === "(") depth += 1;
    else if (character === ")") {
      if (depth === 0) return true;
      depth -= 1;
    }
  }
  return depth !== 0;
}

export function hasUnsafePhoneRouteNote(value: string | undefined): boolean {
  const phone = value?.trim().match(PHONE_ROUTE_LABEL);
  if (!phone) return false;
  const bracket = trailingBracketGroup(phone[2]!);
  return Boolean(
    bracket &&
      /\p{L}/u.test(bracket.content) &&
      (PHONE_IN_NOTE.test(bracket.content) || EMAIL_IN_NOTE.test(bracket.content)),
  );
}

export function phoneRouteNumbers(value: string | undefined): string[] {
  const phone = value?.trim().match(PHONE_ROUTE_LABEL);
  if (!phone) return [];
  const bracket = trailingBracketGroup(phone[2]!);
  const prefix = bracket && /\p{L}/u.test(bracket.content) ? bracket.prefix : phone[2]!;
  try {
    return numbers(prefix);
  } catch {
    const found = new Set<string>();
    for (const piece of prefix.split(/\s+or\s+|[;,]/i)) {
      try {
        numbers(piece).forEach((number) => found.add(number));
      } catch {
        continue;
      }
    }
    return [...found];
  }
}

const numberFrom = (value: string): string | undefined => {
  try {
    return numbers(value)[0];
  } catch {
    return undefined;
  }
};

const candidateKeysFrom = (text: string): string[] => {
  const keys: string[] = [];
  for (const match of text.match(PHONE_CANDIDATE) ?? []) {
    const parts = /^\d{8}\s+\d{8}$/.test(match) ? match.split(/\s+/) : [match];
    for (const part of parts) {
      const key = numberKey(part);
      if (key.length >= 10 && key.length <= 15) keys.push(`W#${key}`);
    }
  }
  return keys;
};

export function labelShowsClosed(label: string | undefined, closed: ReadonlySet<string>): boolean {
  const text = label?.trim();
  if (!text) return false;
  for (const parsed of phoneRouteNumbers(text)) {
    if (closed.has(`W#${numberKey(parsed)}`)) return true;
  }
  const bracket = trailingBracketGroup(text);
  const segments =
    bracket && /\p{L}/u.test(bracket.content)
      ? [bracket.prefix, bracket.content]
      : bracket
        ? [text, bracket.prefix, bracket.content]
        : [text];
  return segments.some((segment) => candidateKeysFrom(segment).some((key) => closed.has(key)));
}

/** Parses the list's best-route label. A value that is not understood is not a route. */
export function routeOf(value: string | undefined): ProspectRoute | undefined {
  const label = value?.trim();
  if (!label || label.length > 64) return undefined;
  const phone = label.match(PHONE_ROUTE_LABEL);
  if (phone) {
    try {
      // A bracket with letters is a note; a bracket of digits is kept only when the number can't be read two ways.
      const bracket = trailingBracketGroup(phone[2]!);
      let to: string | undefined;
      let noteText: string | undefined;
      if (bracket && /\p{L}/u.test(bracket.content)) {
        to = numberFrom(bracket.prefix);
        noteText = bracket.content;
      } else {
        const prefix = bracket?.prefix.trim();
        const prefixDigits = prefix?.replace(/\D/g, "") ?? "";
        const prefixNumber = prefix ? numberFrom(prefix) : undefined;
        const prefixComplete = Boolean(
          prefixNumber &&
            (prefix!.startsWith("+")
              ? prefixDigits.length >= 10 && prefixDigits.length <= 15
              : !prefix!.includes("+") &&
                (/^[3689]\d{7}$/.test(prefixDigits) || (prefixDigits.length >= 10 && prefixDigits.length <= 15))),
        );
        const whole = numberFrom(phone[2]!);
        if (prefixComplete) {
          if (whole && whole !== prefixNumber) return undefined;
          if (!whole && bracket && numberFrom(bracket.content)) return undefined;
          to = whole ?? prefixNumber;
        } else {
          to = whole;
        }
      }
      const note =
        noteText &&
        Array.from(noteText).length <= 40 &&
        /\p{L}/u.test(noteText) &&
        !PHONE_IN_NOTE.test(noteText) &&
        !EMAIL_IN_NOTE.test(noteText)
          ? noteText
          : undefined;
      if (!to) return undefined;
      const direct = phone[1]!.toLowerCase() === "dm phone";
      const mobile = /^65[89]\d{7}$/.test(to);
      const channel = phone[1]!.toLowerCase() === "whatsapp" || mobile ? "whatsapp" : "call";
      return { channel, to, direct, label, ...(note ? { note } : {}) };
    } catch {
      return undefined;
    }
  }
  const email = label.match(/^(DM email|Email)\s*\(([^)]+)\)\s*(.+)$/i);
  if (email) {
    if (email[2]!.trim().toLowerCase() !== "valid") return undefined;
    try {
      const to = address(email[3]);
      if (!to) return undefined;
      return { channel: "email", to, direct: email[1]!.toLowerCase() === "dm email", label };
    } catch {
      return undefined;
    }
  }
  const social = label.match(/^(Instagram DM|Facebook message)\s+(.+)$/i);
  if (social) {
    const channel = social[1]!.toLowerCase().startsWith("instagram") ? "instagram" : "facebook";
    return { channel, to: social[2]!.trim(), direct: false, label };
  }
  return undefined;
}
