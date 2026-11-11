/**
 * `npm run traces [-- N]`: son N run'ı (varsayılan 3) sohbet ve adımlarıyla yazdırır.
 * Trace ekranı (Aşama 3) gelene kadar "ajan ne yaptı?" sorusunun cevabı.
 */
import { collections, closeDb } from "../app/lib/db.server";

const n = Number(process.argv[2] ?? 3);
try {
  const traces = await collections.traces().find().sort({ startedAt: -1 }).limit(n).toArray();
  for (const t of traces.reverse()) {
    console.log(`\n━━ run ${t.runId}  [${t.status}]  ${t.durationMs} ms · ${t.usage.requests} model çağrısı · ${t.usage.totalTokens} token`);
    console.log(`   Müşteri: ${t.input}`);
    for (const s of t.spans) {
      const extra =
        s.type === "model"
          ? `${s.provider}/${s.model}${s.fallbackReason ? ` (fallback: ${s.fallbackReason})` : ""}${s.tokens ? ` · ${s.tokens.total} token` : ""}${s.error ? ` · HATA: ${s.error}` : ""}`
          : s.type === "tool"
            ? `${JSON.stringify(s.input)} → ${JSON.stringify(s.output)}`
            : "";
      console.log(`   · ${s.type.padEnd(7)} ${s.name}  ${s.durationMs} ms  ${extra}`);
    }
    console.log(`   Cevap (${t.lastAgent ?? "-"}): ${t.finalOutput ?? t.error}`);
  }
} finally {
  await closeDb();
}
