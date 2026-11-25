import type { ProspectRoute } from "@a11-wild/shared";
import { address, numbers } from "./load.js";

/** Parses the list's best-route label. A value that is not understood is not a route. */
export function routeOf(value: string | undefined): ProspectRoute | undefined {
  const label = value?.trim();
  if (!label || label.length > 64) return undefined;
  const phone = label.match(/^(DM phone|Phone|WhatsApp)\s+(.+)$/i);
  if (phone) {
    try {
      const to = numbers(phone[2])[0];
      if (!to) return undefined;
      const direct = phone[1]!.toLowerCase() === "dm phone";
      const mobile = /^65[89]\d{7}$/.test(to);
      const channel = phone[1]!.toLowerCase() === "whatsapp" || mobile ? "whatsapp" : "call";
      return { channel, to, direct, label };
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
