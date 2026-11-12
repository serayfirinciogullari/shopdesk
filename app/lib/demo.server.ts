/**
 * Canlı demoda bir senaryoyu tekrar denenebilir hâle getirir.
 *
 * Sorun: bir ziyaretçi #1047 iadesini Inbox'tan onaylarsa, sonraki ziyaretçide kod
 * (doğru olarak) "bu ürün için zaten iade var" der ve demo gösterilemez. Çözüm: senaryo
 * butonuna basılınca sadece o siparişin iade kayıtlarını ve bunlara bağlı ticket'ları sil.
 * Siparişler iade sırasında değişmediği için yeniden yazmaya gerek yok.
 */
import { collections } from "./db.server";
import { runVerdict, summarizeRun } from "./trace-view";

/**
 * Ana sayfadaki canlı sahne: gerçek bir prompt injection run'ı. Mesaj, adımlar, kural
 * kararı ve cevap trace'ten okunur; sahne bunları sadece tekrar oynatır (model çağrılmaz).
 * Kuralın reddettiği bir run yoksa null döner ve sahne gösterilmez (uydurma veri yok).
 */
export async function findStageRun() {
  const candidates = await collections
    .traces()
    .find({ input: { $regex: "^Ignore all previous instructions", $options: "i" }, status: "ok", resumedFrom: { $exists: false } })
    .sort({ startedAt: -1 })
    .limit(10)
    .toArray();
  const t = candidates.find((c) => runVerdict(c).title.startsWith("Refused by rule") && c.finalOutput);
  if (!t) return null;
  const summary = summarizeRun(t);
  return {
    runId: t.runId,
    message: t.input,
    reply: t.finalOutput!,
    verdict: runVerdict(t),
    steps: summary.steps.filter((s) => s.kind === "agent" || s.kind === "handoff" || s.kind === "tool").map((s) => ({ kind: s.kind, label: s.label, offsetMs: s.offsetMs })),
    durationMs: t.durationMs,
  };
}

export async function resetDemoOrder(orderNumber: string) {
  const returns = await collections.returns().find({ orderNumber }, { projection: { _id: 1 } }).toArray();
  const ids = returns.map((r) => r._id!);
  if (ids.length === 0) return { returns: 0, tickets: 0 };
  const tickets = await collections.tickets().deleteMany({ returnId: { $in: ids } });
  const deleted = await collections.returns().deleteMany({ _id: { $in: ids } });
  return { returns: deleted.deletedCount, tickets: tickets.deletedCount };
}
