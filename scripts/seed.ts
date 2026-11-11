/**
 * `npm run seed`: demo mağazasına 20 sahte sipariş yazar (veri: scripts/lib/store.ts).
 *
 * `orders` yeniden yazılır; `returns` ve `tickets` silinir (eski test iadeleri
 * "bu ürün için zaten iade var" kilidi yaratmasın). Sohbetlere ve trace'lere dokunulmaz.
 */
import { closeDb } from "../app/lib/db.server";
import { DAY, resetStore } from "./lib/store";

try {
  const { orders, deleted } = await resetStore();
  console.log(`✅ ${orders.length} sipariş yazıldı. Silinen: ${deleted.returns} iade kaydı, ${deleted.tickets} ticket.`);
  for (const o of orders) {
    const flags = [
      o.items.some((i) => i.finalSale) && "final sale",
      o.total >= 3000 && "yüksek tutar",
      o.deliveredAt && Date.now() - o.deliveredAt.getTime() > 30 * DAY && ">30 gün",
    ].filter(Boolean);
    console.log(`   ${o.orderNumber}  ${o.status.padEnd(10)} ${String(o.total).padStart(5)} TRY  ${o.email}${flags.length ? "  [" + flags.join(", ") + "]" : ""}`);
  }
} finally {
  await closeDb();
}
