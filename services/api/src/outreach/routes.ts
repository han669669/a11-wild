import type { ProspectRoute } from "@a11-wild/shared";
import { EMAIL_IN_TEXT } from "./blocked.js";
import { address, numbers } from "./load.js";

const EMAIL_IN_NOTE = new RegExp(EMAIL_IN_TEXT.source, EMAIL_IN_TEXT.flags.replace("g", ""));
const PHONE_IN_NOTE = /\+?\d[\d().\s-]{5,}\d/;

const trailingBracketGroup = (value: string): { prefix: string; content: string } | undefined => {
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

const numberFrom = (value: string): string | undefined => {
  try {
    return numbers(value)[0];
  } catch {
    return undefined;
  }
};

const withoutBracketGroups = (value: string): string => {
  let withoutBrackets = value;
  while (true) {
    const next = withoutBrackets.replace(/\([^()]*\)/g, " ");
    if (next === withoutBrackets) return withoutBrackets;
    withoutBrackets = next;
  }
};

type BracketGroup = { start: number; end: number; content: string };

const topLevelBracketGroups = (value: string): BracketGroup[] => {
  const groups: BracketGroup[] = [];
  const openings: number[] = [];
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === "(") openings.push(i);
    else if (value[i] === ")" && openings.length > 0) {
      const opening = openings.pop()!;
      if (openings.length === 0) groups.push({ start: opening, end: i + 1, content: value.slice(opening + 1, i) });
    }
  }
  return groups;
};

const completeLabelNumbers = (text: string): string[] => {
  const candidates = new Set<string>();
  for (const match of text.matchAll(/\+?\d[\d().\s-]{5,}\d/g)) candidates.add(match[0]);
  return [...candidates].filter((candidate) => {
    const digits = candidate.replace(/\D/g, "");
    const countryCode = digits.length >= 10 && digits.length <= 15 && (candidate.startsWith("+") || !candidate.includes("+"));
    const local = !candidate.includes("+") && /^[689]\d{7}$/.test(digits);
    return countryCode || local;
  });
};

const digitGroupsUnwrapped = (value: string): string => {
  const groups = topLevelBracketGroups(value);
  let result = "";
  let cursor = 0;
  for (const group of groups) {
    result += value.slice(cursor, group.start);
    result += /^[\d\s.-]+$/.test(group.content) ? ` ${group.content} ` : " ";
    cursor = group.end;
  }
  return result + value.slice(cursor);
};

export function labelShowsClosed(label: string | undefined, closed: ReadonlySet<string>): boolean {
  const digits = label?.replace(/\D/g, "") ?? "";
  for (const key of closed) {
    if (!key.startsWith("W#")) continue;
    const number = key.slice(2);
    if (number && (digits.includes(number) || (/^65\d{8}$/.test(number) && digits.includes(number.slice(2))))) return true;
  }
  return false;
}

export function labelContactNumbers(label: string | undefined): string[] {
  if (!label) return [];
  const keysFrom = (text: string): string[] => {
    const keys: string[] = [];
    for (const segment of text.split(/[;,/]/)) {
      const candidates = completeLabelNumbers(withoutBracketGroups(segment));
      keys.push(...(candidates.length ? candidates : completeLabelNumbers(digitGroupsUnwrapped(segment))));
      for (const group of topLevelBracketGroups(segment)) {
        if (/\p{L}/u.test(group.content)) keys.push(...keysFrom(group.content));
      }
    }
    return keys;
  };
  return [...new Set(keysFrom(label))];
}

/** Parses the list's best-route label. A value that is not understood is not a route. */
export function routeOf(value: string | undefined): ProspectRoute | undefined {
  const label = value?.trim();
  if (!label || label.length > 64) return undefined;
  const phone = label.match(/^(DM phone|Phone|WhatsApp)\s+(.+)$/i);
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
