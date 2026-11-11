/**
 * Araçlar (tools): ajanın çağırabildiği, bizim yazdığımız fonksiyonlar.
 *
 * Demonun kalbi: kurallar prompt'ta değil burada, kodda. Model "bu siparişi göster"
 * dese bile, numara ile e-posta eşleşmiyorsa kod veri döndürmez.
 */
import { tool } from "@openai/agents";
import { z } from "zod";
import { collections } from "~/lib/db.server";

/** "1042", "#1042", " #1042 " → "#1042" */
export function normalizeOrderNumber(raw: string): string | null {
  const digits = raw.replace(/[^0-9]/g, "");
  return digits ? `#${digits}` : null;
}

export function normalizeEmail(raw: string): string | null {
  const e = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

// Yanlış numara ile yanlış e-posta aynı cevabı alır; böylece "bu numaralı bir
// sipariş var mı?" bilgisi bile sızmaz.
const NOT_FOUND = {
  found: false,
  reason: "No order matches this order number and email. Do not share any order details; ask the customer to double-check both.",
} as const;

export const getOrderStatus = tool({
  name: "getOrderStatus",
  description:
    "Look up an order's status and tracking link. Requires BOTH the order number and the email used for the order, exactly as the customer gave them. Never guess either value.",
  parameters: z.object({
    orderNumber: z.string().describe("Order number as the customer wrote it, e.g. #1042"),
    email: z.string().describe("Email address the customer gave"),
  }),
  execute: async ({ orderNumber, email }) => {
    const num = normalizeOrderNumber(orderNumber);
    const mail = normalizeEmail(email);
    if (!num || !mail) {
      return {
        found: false,
        reason: `Missing or invalid ${!num ? "order number" : "email"}. Ask the customer for it; do not guess.`,
      };
    }

    const order = await collections.orders().findOne({ orderNumber: num });
    if (!order || order.email !== mail) return NOT_FOUND;

    // Sadece müşterinin ihtiyacı olan alanlar; e-posta, isim vb. modele hiç verilmez.
    return {
      found: true,
      orderNumber: order.orderNumber,
      status: order.status,
      items: order.items.map((i) => `${i.qty} × ${i.name}`),
      total: `${order.total} ${order.currency}`,
      orderedAt: order.createdAt.toISOString().slice(0, 10),
      shippedAt: order.shippedAt?.toISOString().slice(0, 10) ?? null,
      deliveredAt: order.deliveredAt?.toISOString().slice(0, 10) ?? null,
      trackingUrl: order.trackingUrl ?? null,
    };
  },
});
