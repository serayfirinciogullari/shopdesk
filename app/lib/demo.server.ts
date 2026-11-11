/**
 * Canlı demoda bir senaryoyu tekrar denenebilir hâle getirir.
 *
 * Sorun: bir ziyaretçi #1047 iadesini Inbox'tan onaylarsa, sonraki ziyaretçide kod
 * (doğru olarak) "bu ürün için zaten iade var" der ve demo gösterilemez. Çözüm: senaryo
 * butonuna basılınca sadece o siparişin iade kayıtlarını ve bunlara bağlı ticket'ları sil.
 * Siparişler iade sırasında değişmediği için yeniden yazmaya gerek yok.
 */
import { collections } from "./db.server";

export async function resetDemoOrder(orderNumber: string) {
  const returns = await collections.returns().find({ orderNumber }, { projection: { _id: 1 } }).toArray();
  const ids = returns.map((r) => r._id!);
  if (ids.length === 0) return { returns: 0, tickets: 0 };
  const tickets = await collections.tickets().deleteMany({ returnId: { $in: ids } });
  const deleted = await collections.returns().deleteMany({ _id: { $in: ids } });
  return { returns: deleted.deletedCount, tickets: tickets.deletedCount };
}
