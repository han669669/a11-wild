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

/** Parses the list's best-route label. A value that is not understood is not a route. */
export function routeOf(value: string | undefined): ProspectRoute | undefined {
  const label = value?.trim();
  if (!label || label.length > 64) return undefined;
  const phone = label.match(/^(DM phone|Phone|WhatsApp)\s+(.+)$/i);
  if (phone) {
    try {
      const bracket = trailingBracketGroup(phone[2]!);
      const noteCandidate = bracket && /\p{L}/u.test(bracket.content) ? bracket : undefined;
      const numberLikeSuffix = bracket && PHONE_IN_NOTE.test(bracket.content) ? bracket : undefined;
      const split = noteCandidate ?? numberLikeSuffix;
      const notedNumber = split ? numberFrom(split.prefix) : undefined;
      const numberText = notedNumber ? split!.prefix : phone[2]!;
      const noteText = noteCandidate && notedNumber ? noteCandidate.content : undefined;
      const note =
        noteText &&
        Array.from(noteText).length <= 40 &&
        /\p{L}/u.test(noteText) &&
        !PHONE_IN_NOTE.test(noteText) &&
        !EMAIL_IN_NOTE.test(noteText)
          ? noteText
          : undefined;
      const to = notedNumber ?? numbers(numberText)[0];
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
