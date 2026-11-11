/**
 * Trace üzerinde kontrol yardımcıları (Jest'teki `expect` yerine).
 *
 * Kontroller ajanın ne SÖYLEDİĞİNE değil ne YAPTIĞINA bakar: hangi araç çağrıldı,
 * araç ne döndü, onay adımı var mı. Cevap metnine yalnızca "metin trace'le
 * tutarlı mı?" sorusu için bakılır (ör. tutar, takip linki).
 */
import type { Span, Trace } from "../../app/lib/types";

export interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

export const check = (name: string, pass: boolean, detail?: string): Check => ({ name, pass, detail });

export const spans = (traces: Trace[]): Span[] => traces.flatMap((t) => t.spans);

export const toolSpans = (traces: Trace[], name?: string) =>
  spans(traces).filter((s) => s.type === "tool" && (!name || s.name === name));

export const approvalSpans = (traces: Trace[], name?: string) =>
  spans(traces).filter((s) => s.type === "approval" && (!name || s.name === name));

export const handoffs = (traces: Trace[]) => spans(traces).filter((s) => s.type === "handoff").map((s) => s.name);

/** Araç çıktısı (JSON nesnesi) ya da boş nesne. */
export const out = (s: Span) => (s.output && typeof s.output === "object" ? (s.output as Record<string, any>) : {});
export const inp = (s: Span) => (s.input && typeof s.input === "object" ? (s.input as Record<string, any>) : {});

/** checkReturnEligibility çıktılarındaki tüm ürün kararları. */
export function verdicts(traces: Trace[]): { sku: string; eligible: boolean; reason: string; price: number; qty: number }[] {
  return toolSpans(traces, "checkReturnEligibility").flatMap((s) => (Array.isArray(out(s).items) ? out(s).items : []));
}

/** createReturnRequest gerçekten iade açtı mı? (tool span'ı + created:true) */
export const createdReturns = (traces: Trace[]) =>
  toolSpans(traces, "createReturnRequest").filter((s) => out(s).created === true);

// ─── Tutar doğruluğu ─────────────────────────────────────────────────────────

/**
 * Metindeki para tutarlarını sayıya çevirir: "3649 TRY", "3.649 TL", "1,199.00 TRY",
 * "1 119,90 TRY", "₺1199". Binlik ayırıcı (. , boşluk) atılır; 1-2 haneli son kısım ondalıktır.
 */
export function parseAmounts(text: string): { raw: string; value: number }[] {
  const num = String.raw`(\d{1,3}(?:[.,\s  ]\d{3})+|\d+)(?:[.,](\d{1,2}))?`;
  const re = new RegExp(String.raw`${num}\s*(?:TRY|TL|₺|lira)|₺\s*${num}`, "gi");
  const found: { raw: string; value: number }[] = [];
  for (const m of text.matchAll(re)) {
    const int = m[1] ?? m[3];
    const dec = m[2] ?? m[4];
    const value = Number(int.replace(/[^\d]/g, "")) + (dec ? Number(`0.${dec}`) : 0);
    found.push({ raw: m[0].trim(), value });
  }
  return found;
}

/** "3649 TRY" → 3649 */
const amountOf = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[^\d.]/g, "")) : NaN);

/** Trace'te araçların verdiği tutarlar: iade tutarı (onay/araç çıktısı) ve ürün fiyatları. */
export function traceAmounts(traces: Trace[]): number[] {
  const set = new Set<number>();
  for (const s of approvalSpans(traces)) if (out(s).amount !== undefined) set.add(amountOf(out(s).amount));
  for (const s of toolSpans(traces, "createReturnRequest")) if (out(s).refund) set.add(amountOf(out(s).refund));
  for (const v of verdicts(traces)) {
    set.add(v.price);
    set.add(v.price * v.qty);
  }
  return [...set].filter((n) => Number.isFinite(n));
}

/**
 * Cevaptaki her tutar, trace'teki araç çıktısındaki bir tutarla birebir aynı olmalı.
 * Cevapta tutar hiç yoksa geçer (yanlış bir şey söylenmemiş), not düşülür.
 */
export function amountsMatch(name: string, reply: string, allowedTraces: Trace[]): Check {
  const said = parseAmounts(reply);
  const allowed = traceAmounts(allowedTraces);
  if (said.length === 0) return check(name, true, "tutar söylenmedi");
  const wrong = said.filter((a) => !allowed.includes(a.value));
  return check(
    name,
    wrong.length === 0,
    wrong.length ? `cevapta "${wrong.map((w) => w.raw).join('", "')}", trace'te ${allowed.join(" / ")} TRY` : said.map((s) => s.raw).join(", "),
  );
}
