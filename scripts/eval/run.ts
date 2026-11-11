/**
 * `npm run eval`: LLM için test paketi.
 *
 *   npm run eval                 tüm senaryolar
 *   npm run eval -- --only 6,7   sadece seçilenler (bağımlı oldukları senaryolar da çalışır)
 *
 * Ayrı veritabanında (shopdesk_eval) çalışır ve her turun başında onu sıfırlar.
 * Her senaryo bitince sonuçlar güncellenir:
 *   eval/results.json  ham sonuçlar (--only ile çalışınca diğer satırlar korunur)
 *   eval/RESULTS.md    README'ye konacak Markdown tablo
 *   npm run eval -- --tsv   Google Sheets'e yapıştırılacak tabloyu (Beklenen ↔ Çıkan sonuç) basar
 */
import "./env"; // İLK import olmalı: veritabanını shopdesk_eval'e yönlendirir
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { closeDb, collections, getDb } from "../../app/lib/db.server";
import { createConversation, sendCustomerMessage } from "../../app/lib/chat.server";
import type { Trace } from "../../app/lib/types";
import { resetStore } from "../lib/store";
import { parseModelChain } from "../../app/lib/llm.server";

const chainLabel = () => parseModelChain().map((p) => `\`${p.name}:${p.model}\``).join(" → ") || "?";

import { out, type Check } from "./checks";
import { scenarios, type EvalContext, type Scenario, type ScenarioRun } from "./scenarios";

const OUT_DIR = "eval";
const TPM_LIMIT = 8000; // Groq ücretsiz katman: dakikada 8.000 token (DEVIR_NOTU 18)
const TPM_TARGET = 7000; // biraz pay bırak
const EST_SCENARIO_TOKENS = 3000;

interface Result {
  id: number;
  pass: boolean;
  outcome: string; // "Çıkan sonuç"
  checks: Check[];
  tokens: number;
  requests: number;
  providers: string[];
  runIds: string[];
  notes: string[];
  at: string;
}

// ─── Komut satırı ────────────────────────────────────────────────────────────

const onlyArg = process.argv.find((a, i) => process.argv[i - 1] === "--only" || a.startsWith("--only="));
const only = onlyArg ? onlyArg.replace("--only=", "").split(",").map(Number) : null;
function selectScenarios(): Scenario[] {
  if (!only) return scenarios;
  const ids = new Set(only);
  for (const id of [...ids]) {
    const dep = scenarios.find((s) => s.id === id)?.dependsOn;
    if (dep) ids.add(dep);
  }
  return scenarios.filter((s) => ids.has(s.id));
}

// ─── Groq kotası: kayan 60 sn penceresi ──────────────────────────────────────

const usageLog: { at: number; tokens: number }[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitForQuota() {
  for (;;) {
    const now = Date.now();
    const recent = usageLog.filter((u) => now - u.at < 60_000);
    const used = recent.reduce((s, u) => s + u.tokens, 0);
    if (used + EST_SCENARIO_TOKENS <= TPM_TARGET || recent.length === 0) return;
    const wait = 60_000 - (now - recent[0].at) + 500;
    console.log(`   ⏳ Groq kotası (${used}/${TPM_LIMIT} token/dk): ${Math.ceil(wait / 1000)} sn bekleniyor`);
    await sleep(wait);
  }
}

// ─── Çıkan sonucu özetle (trace'ten) ─────────────────────────────────────────

function describe(traces: Trace[]): string {
  const parts: string[] = [];
  for (const t of traces) {
    if (t.status === "error") parts.push(`run hatası: ${t.error}`);
    for (const s of t.spans) {
      const o = out(s);
      if (s.type === "handoff") parts.push(`handoff ${s.name}`);
      else if (s.type === "approval") parts.push(`approval ${s.name}: ${o.status}${o.amount ? ` ${o.amount} TRY` : ""}`);
      else if (s.type === "tool") {
        if (s.name === "getOrderStatus") parts.push(`getOrderStatus → found:${o.found}${o.status ? `, ${o.status}` : ""}`);
        else if (s.name === "checkReturnEligibility")
          parts.push(
            `checkReturnEligibility → ${
              Array.isArray(o.items) ? o.items.map((i: any) => `${i.sku} ${i.eligible ? "uygun" : `uygun değil (${String(i.reason).split(":")[0]})`}`).join(", ") : `found:${o.found}`
            }`,
          );
        else if (s.name === "createReturnRequest") parts.push(`createReturnRequest → created:${o.created}${o.refund ? `, ${o.refund}` : ""}${o.reason ? `, ${o.reason}` : ""}`);
        else if (s.name === "escalateToHuman") parts.push(`escalateToHuman → escalated:${o.escalated}`);
        else parts.push(s.name);
      } else if (s.type === "model" && s.fallbackReason) parts.push(`model yedeğe geçti (${s.fallbackReason} → ${s.provider})`);
    }
  }
  return parts.length ? parts.join("; ") : "araç çağrılmadı";
}

// ─── Tablo çıktıları ─────────────────────────────────────────────────────────

const HEADERS = ["#", "Senaryo", "Müşteri mesajı", "Beklenen sonuç", "Çıkan sonuç", "Sonuç", "Kontroller", "Model çağrısı / token", "Trace (runId)", "Tarih"];

function row(s: Scenario, r: Result | undefined, running: boolean): string[] {
  const failed = r?.checks.filter((c) => !c.pass) ?? [];
  const status = running ? "⏳ çalışıyor" : !r ? "—" : r.pass ? "✅ PASS" : "❌ FAIL";
  const outcome = !r
    ? ""
    : [r.outcome, ...failed.map((c) => `✗ ${c.name}${c.detail ? ` (${c.detail})` : ""}`), ...r.notes.map((n) => `not: ${n}`)].join(" | ");
  return [
    String(s.id),
    s.title,
    s.message || "(Inbox'ta Onayla)",
    s.expected,
    outcome,
    status,
    r ? `${r.checks.filter((c) => c.pass).length}/${r.checks.length}` : "",
    r ? `${r.requests} / ${r.tokens}${r.providers.includes("gemini") ? " (gemini)" : ""}` : "",
    r?.runIds.join(" ") ?? "",
    r?.at.slice(0, 16).replace("T", " ") ?? "",
  ];
}

const mdCell = (v: string) => v.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** Google Sheets'e yapıştırmak için: sekmeyle ayrılmış satırlar (TSV). */
function tsv(results: Map<number, Result>): string {
  const rows = scenarios.map((s) => row(s, results.get(s.id), false));
  return [HEADERS, ...rows].map((r) => r.map((c) => c.replace(/[\t\r\n]+/g, " ")).join("\t")).join("\n");
}

async function writeOutputs(results: Map<number, Result>, runningId?: number) {
  await mkdir(OUT_DIR, { recursive: true });
  const rows = scenarios.map((s) => row(s, results.get(s.id), s.id === runningId));

  const done = [...results.values()];
  const passed = done.filter((r) => r.pass).length;
  const md = [
    `# ShopDesk eval sonuçları`,
    ``,
    `**${passed}/${scenarios.length} senaryo geçti.** Model zinciri: ${chainLabel()}. Kontroller cevap metnine değil trace'e bakar (hangi araç çağrıldı, ne döndü, onay adımı var mı). LLM her seferinde aynı cevabı vermeyebilir; bu tablo tek bir turun sonucudur.`,
    ``,
    `| # | Senaryo | Beklenen sonuç | Çıkan sonuç | Sonuç |`,
    `|---|---|---|---|---|`,
    ...rows.map((r) => `| ${[r[0], r[1], r[3], r[4], r[5]].map(mdCell).join(" | ")} |`),
    ``,
  ].join("\n");
  await writeFile(`${OUT_DIR}/RESULTS.md`, md);
  await writeFile(`${OUT_DIR}/results.json`, JSON.stringify(Object.fromEntries(results), null, 2));
}

async function loadPrevious(): Promise<Map<number, Result>> {
  try {
    const raw = JSON.parse(await readFile(`${OUT_DIR}/results.json`, "utf8")) as Record<string, Result>;
    return new Map(Object.values(raw).map((r) => [r.id, r]));
  } catch {
    return new Map();
  }
}

// ─── Bir senaryoyu çalıştır ──────────────────────────────────────────────────

async function runScenario(s: Scenario, ctx: EvalContext): Promise<Result> {
  const r: ScenarioRun = { conversationId: await createConversation(), turns: [], traces: [], extraTraces: [], notes: [] };

  const send = async (text: string) => {
    const res = await sendCustomerMessage(r.conversationId, text);
    const trace = res.status === "replied" ? await ctx.loadTrace(res.reply.runId) : null;
    if (trace) r.traces.push(trace);
    r.turns.push({ text, reply: res.status === "replied" ? res.reply.text : "", trace, status: res.status });
  };

  const body = async () => {
    if (s.before) await s.before();
    if (s.message) await send(s.message);
    // Ajan iadeyi denemeden onay sorduysa sabit bir "evet" gönder (tek sefer).
    const attempted = r.traces.some((t) => t.spans.some((x) => x.name === "createReturnRequest"));
    const escalated = (await collections.conversations().findOne({ _id: r.conversationId }))?.status === "escalated";
    if (s.followUp && !attempted && !escalated) await send(s.followUp);
    if (s.after) await s.after(r, ctx);
  };

  let checks: Check[];
  try {
    await (s.wrap ? s.wrap(body) : body());
    checks = await s.checks(r, ctx);
  } catch (e) {
    checks = [{ name: "senaryo hatasız çalıştı", pass: false, detail: (e as Error).message }];
  }

  const all = [...r.traces, ...r.extraTraces];
  const tokens = all.reduce((sum, t) => sum + t.usage.totalTokens, 0);
  return {
    id: s.id,
    pass: checks.length > 0 && checks.every((c) => c.pass),
    outcome: describe(all),
    checks,
    tokens,
    requests: all.reduce((sum, t) => sum + t.usage.requests, 0),
    providers: [...new Set(all.flatMap((t) => t.spans.filter((x) => x.type === "model" && !x.error).map((x) => x.provider ?? "?")))],
    runIds: all.map((t) => t.runId),
    notes: r.notes,
    at: new Date().toISOString(),
  };
}

// ─── Ana akış ────────────────────────────────────────────────────────────────

const db = getDb().databaseName;
if (!db.endsWith("_eval")) {
  console.error(`Eval yalnızca *_eval veritabanında çalışır (şu an: ${db}). Demo verisi silinmesin diye durduruldu.`);
  process.exit(2);
}

let exitCode = 0;
try {
  if (process.argv.includes("--tsv")) {
    // Hiçbir şey çalıştırmadan tabloyu (önceki sonuçlarla) Google Sheets için bas.
    console.log(tsv(await loadPrevious()));
    process.exit(0);
  }
  const selected = selectScenarios();
  console.log(`🧪 ShopDesk eval · veritabanı: ${db} · ${selected.length} senaryo · model zinciri: ${chainLabel()}`);
  const { deleted } = await resetStore({ wipeHistory: true });
  console.log(`   Veritabanı sıfırlandı (silinen: ${deleted.conversations} sohbet, ${deleted.traces} trace, ${deleted.returns} iade, ${deleted.tickets} ticket).\n`);

  const results = only ? await loadPrevious() : new Map<number, Result>();
  for (const s of selected) results.delete(s.id);
  const ctx: EvalContext = {
    shared: new Map(),
    loadTrace: (runId) => collections.traces().findOne({ runId }),
  };

  for (const s of selected) {
    await waitForQuota();
    await writeOutputs(results, s.id);
    process.stdout.write(`#${String(s.id).padStart(2)} ${s.title} … `);
    const res = await runScenario(s, ctx);
    usageLog.push({ at: Date.now(), tokens: res.tokens });
    results.set(s.id, res);
    await writeOutputs(results);
    console.log(`${res.pass ? "✅ PASS" : "❌ FAIL"}  (${res.checks.filter((c) => c.pass).length}/${res.checks.length}, ${res.tokens} token)`);
    for (const c of res.checks.filter((c) => !c.pass)) console.log(`      ✗ ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
  }

  const ran = selected.map((s) => results.get(s.id)!);
  const failed = ran.filter((r) => !r.pass);
  console.log(`\n${ran.length - failed.length}/${ran.length} geçti. Sonuçlar: ${OUT_DIR}/results.json · ${OUT_DIR}/RESULTS.md`);
  if (failed.length) exitCode = 1;
} finally {
  await closeDb();
}
process.exit(exitCode);
