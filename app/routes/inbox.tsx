/**
 * /inbox: temsilci ekranı. Ajanın insana bıraktığı işler (escalation ve
 * onay bekleyen iadeler) burada; temsilci Onayla / Reddet ile karar verir.
 *
 * Düzen lookfor'un Unified Inbox'ı gibi üç bölme: solda kuyruk, ortada sohbet, sağda
 * sipariş ve "kod neyi kontrol etti?". Seçili ticket ve kuyruk URL'de (`?q=open&t=…`).
 *
 * loader ≈ GET /inbox, action ≈ POST /inbox (Express'teki iki handler).
 * Karar mantığı (kilit, onaylı run'ı sürdürme, yedek yol) inbox.server.ts'te, değişmedi.
 */
import { useEffect, useState } from "react";
import { data, Link, useFetcher, useSearchParams } from "react-router";
import { AgentText } from "~/components/AgentText";
import { ObjectId } from "mongodb";
import type { Route } from "./+types/inbox";
import { collections } from "~/lib/db.server";
import { decideTicket, type Decision } from "~/lib/inbox.server";
import { checkRateLimit } from "~/lib/ratelimit.server";
import { ruleChecks } from "~/lib/trace-view";
import { Nav, TicketPill } from "~/components/ui";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Inbox · ShopDesk" }];
}

const ORDER_RE = /#\s?(\d{4})\b/;

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q") === "done" ? "done" : "open";

  const tickets = collections.tickets();
  const [open, done] = await Promise.all([
    tickets.find({ status: "open" }).sort({ createdAt: -1 }).limit(50).toArray(),
    tickets.find({ status: { $ne: "open" } }).sort({ decidedAt: -1 }).limit(20).toArray(),
  ]);
  const list = q === "open" ? open : done;

  // İlgili iade kayıtlarını tek sorguda çek (SQL'de JOIN; Mongo'da `$in` ile ikinci okuma).
  const all = [...open, ...done];
  const returnIds = all.flatMap((t) => (t.returnId ? [t.returnId] : []));
  const returns = returnIds.length ? await collections.returns().find({ _id: { $in: returnIds } }).toArray() : [];
  const retById = new Map(returns.map((r) => [r._id.toHexString(), r]));

  const rows = list.map((t) => {
    const r = t.returnId ? retById.get(t.returnId.toHexString()) : undefined;
    return {
      id: t._id.toHexString(),
      kind: t.kind,
      status: t.status,
      summary: t.summary,
      createdAt: t.createdAt.toISOString(),
      amount: r?.amount ?? null,
      orderNumber: r?.orderNumber ?? t.summary.match(ORDER_RE)?.[0]?.replace(/\s/, "") ?? null,
    };
  });

  // Seçili ticket: URL'deki, yoksa kuyruğun ilki.
  const wanted = url.searchParams.get("t");
  const selectedDoc = (wanted && ObjectId.isValid(wanted) ? all.find((t) => t._id.toHexString() === wanted) : undefined) ?? list[0];
  let selected = null;
  if (selectedDoc) {
    const [convo, trace] = await Promise.all([
      collections.conversations().findOne({ _id: selectedDoc.conversationId }),
      collections.traces().findOne({ runId: selectedDoc.runId }),
    ]);
    const ret = selectedDoc.returnId ? retById.get(selectedDoc.returnId.toHexString()) : undefined;
    // Sipariş numarası: iade kaydından; escalation'da müşterinin mesajından.
    const orderNumber =
      ret?.orderNumber ??
      convo?.messages.find((m) => m.role === "customer" && ORDER_RE.test(m.text))?.text.match(ORDER_RE)?.[0].replace(/\s/, "") ??
      null;
    const order = orderNumber ? await collections.orders().findOne({ orderNumber }) : null;

    selected = {
      id: selectedDoc._id.toHexString(),
      kind: selectedDoc.kind,
      status: selectedDoc.status,
      reason: selectedDoc.reason,
      summary: selectedDoc.summary,
      suggestedAction: selectedDoc.suggestedAction ?? (selectedDoc.kind === "escalation" ? "Take over the conversation and reply to the customer." : null),
      createdAt: selectedDoc.createdAt.toISOString(),
      decidedAt: selectedDoc.decidedAt?.toISOString() ?? null,
      conversationId: selectedDoc.conversationId.toHexString(),
      runId: selectedDoc.runId,
      resolution: selectedDoc.resolution ?? null,
      resolutionRunId: selectedDoc.resolutionRunId ?? null,
      processing: !!selectedDoc.processingAt,
      messages: (convo?.messages ?? []).map((m) => ({ role: m.role, text: m.text, at: m.at.toISOString(), runId: m.runId ?? null })),
      checks: trace ? ruleChecks(trace.spans) : null,
      ret: ret ? { amount: ret.amount, status: ret.status, items: ret.items.map((i) => ({ name: i.name, qty: i.qty, price: i.price })) } : null,
      order: order
        ? {
            orderNumber: order.orderNumber,
            customerName: order.customerName,
            status: order.status,
            deliveredDaysAgo: order.deliveredAt ? Math.floor((Date.now() - order.deliveredAt.getTime()) / 86_400_000) : null,
            items: order.items.map((i) => ({ name: i.name, qty: i.qty, price: i.price, finalSale: i.finalSale })),
            total: order.total,
          }
        : null,
    };
  }

  return { q, openCount: open.length, rows, selected };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const id = String(form.get("ticketId") ?? "");
  const decision = String(form.get("decision") ?? "") as Decision;
  if (decision !== "approve" && decision !== "reject") return data({ ok: false, message: "Unknown decision." }, { status: 400 });
  // Onay, durdurulmuş run'ı sürdürür (bir model çağrısı); chat ile aynı limite sayılır.
  const limit = await checkRateLimit(request);
  if (!limit.ok) return data({ ok: false, message: limit.message }, { status: 429 });
  const result = await decideTicket(id, decision);
  return data(result, { status: result.ok ? 200 : 409 });
}

type LoaderData = Route.ComponentProps["loaderData"];
type Selected = NonNullable<LoaderData["selected"]>;

export default function Inbox({ loaderData }: Route.ComponentProps) {
  const { q, rows, selected, openCount } = loaderData;
  const [params, setParams] = useSearchParams();
  // Varsayılan seçili ticket'ı da URL'ye yaz: karar verilince ticket "Decided"a geçer,
  // URL'de olmazsa sayfa sonraki ticket'ı açar ve sonuç görünmez.
  useEffect(() => {
    if (selected && !params.has("t")) setParams((p) => { p.set("t", selected.id); return p; }, { replace: true, preventScrollReset: true });
  }, [selected, params, setParams]);
  const href = (next: { q?: string; t?: string | null }) => {
    const p = new URLSearchParams(params);
    if (next.q) p.set("q", next.q);
    if (next.t === null) p.delete("t");
    else if (next.t) p.set("t", next.t);
    return `?${p.toString()}`;
  };

  return (
    <main className="mx-auto max-w-7xl p-4 pb-16">
      <Nav />
      <div className="mt-4 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Inbox</h1>
          <p className="text-sm text-gray-500">Conversations the agent handed to a human, and refunds waiting for approval.</p>
        </div>
      </div>

      <div className="mt-4 grid overflow-hidden rounded-2xl border border-gray-200 bg-white md:grid-cols-[260px_minmax(0,1fr)] xl:grid-cols-[280px_minmax(0,1fr)_320px]">
        {/* ── Kuyruk ── */}
        <section aria-label="Tickets" className="min-w-0 border-b border-gray-200 md:border-r md:border-b-0">
          <div className="flex gap-1 border-b border-gray-200 p-2.5 text-xs">
            <QueueTab to={href({ q: "open", t: null })} active={q === "open"}>Needs you <span className="ml-1 rounded-full bg-gray-200 px-1.5 tabular-nums">{openCount}</span></QueueTab>
            <QueueTab to={href({ q: "done", t: null })} active={q === "done"}>Decided</QueueTab>
          </div>
          {rows.length === 0 ? (
            <p className="p-6 text-center text-sm text-gray-500">{q === "open" ? "Nothing waiting. Try a 3,649 TRY return from the home page." : "No decisions yet."}</p>
          ) : (
            <ul>
              {rows.map((r) => {
                const isSel = selected?.id === r.id;
                return (
                  <li key={r.id}>
                    <Link
                      to={href({ t: r.id })}
                      preventScrollReset
                      aria-current={isSel ? "true" : undefined}
                      className={`relative flex flex-col gap-1.5 border-b border-gray-100 px-4 py-3 text-sm transition-colors ${isSel ? "bg-violet-50" : "hover:bg-gray-50"}`}
                    >
                      {isSel && <span aria-hidden="true" className="anim-grow-y absolute top-2.5 bottom-2.5 left-0 w-0.5 rounded bg-violet-600" />}
                      <span className="flex items-center justify-between gap-2">
                        <KindChip kind={r.kind} />
                        <span className="text-xs text-gray-400 tabular-nums">{new Date(r.createdAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>
                      </span>
                      <span className="line-clamp-2 text-gray-700">{r.summary}</span>
                      <span className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                        {r.orderNumber && <span className="font-mono">{r.orderNumber}</span>}
                        {r.amount !== null && <span className="font-mono tabular-nums">{r.amount.toLocaleString("en-US")} TRY</span>}
                        {r.status !== "open" && <TicketPill status={r.status} />}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {selected ? <TicketView key={selected.id} t={selected} /> : <div className="hidden p-6 text-sm text-gray-500 md:block xl:col-span-2">Pick a ticket.</div>}
      </div>
    </main>
  );
}

// ─── Seçili ticket: sohbet + bağlam ─────────────────────────────────────────

function TicketView({ t }: { t: Selected }) {
  return (
    <>
      <section aria-label="Conversation" className="flex min-w-0 flex-col bg-gray-50 xl:border-r xl:border-gray-200">
        <div className="flex flex-wrap items-center gap-3 border-b border-gray-200 bg-white px-4 py-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gray-900 text-xs font-semibold text-white">
            {(t.order?.customerName ?? "?").split(" ").map((w) => w[0]).join("").slice(0, 2)}
          </span>
          <div className="min-w-0">
            <p className="font-medium">{t.order?.customerName ?? "Customer"}</p>
            <p className="text-xs text-gray-500">Storefront chat{t.order ? ` · ${t.order.orderNumber}` : ""}</p>
          </div>
          <div className="ml-auto flex gap-2 text-xs">
            <Link to={`/traces/${t.runId}`} className="rounded-full border border-gray-300 px-3 py-1 hover:bg-gray-50">Trace</Link>
            <Link to={`/chat/${t.conversationId}`} className="rounded-full border border-gray-300 px-3 py-1 hover:bg-gray-50">Open chat</Link>
          </div>
        </div>
        <div className="flex flex-col gap-3 p-4">
          <div className="anim-rise rounded-xl border border-dashed border-gray-300 bg-white px-3 py-2.5 text-sm">
            <p className="text-[11px] font-medium tracking-wide text-gray-500 uppercase">Agent summary · why a human</p>
            <p className="mt-1">{t.summary}</p>
            <p className="mt-1 text-gray-600"><span className="text-gray-500">Reason:</span> {t.reason}</p>
          </div>
          {t.messages.map((m, i) => (
            <Message key={i} m={m} delayMs={80 + i * 60} />
          ))}
        </div>
      </section>

      <aside aria-label="Order and checks" className="flex min-w-0 flex-col gap-5 border-t border-gray-200 p-4 md:col-span-2 xl:col-span-1 xl:border-t-0">
        {t.order && <OrderCard o={t.order} ret={t.ret} />}
        {t.checks && <Checks t={t} />}
        {t.ret && t.checks?.approval && <LimitBar amount={t.ret.amount} threshold={t.checks.approval.threshold} delayMs={200 + (t.checks.items.length + 1) * 90} />}
        <Decide t={t} />
      </aside>
    </>
  );
}

function Message({ m, delayMs }: { m: Selected["messages"][number]; delayMs: number }) {
  const mine = m.role === "customer";
  return (
    <div className={`anim-rise flex flex-col gap-1 ${mine ? "items-end" : "items-start"}`} style={{ "--d": `${delayMs}ms` } as React.CSSProperties}>
      <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm ${mine ? "rounded-br-md bg-gray-900 text-white" : "rounded-bl-md border border-gray-200 bg-white"}`}>
        {m.role === "human" && <span className="mb-1 block text-xs text-gray-500">Support team</span>}
        <AgentText text={m.text} />
      </div>
      {m.runId && (
        <div className="flex items-center gap-2 text-xs">
          <span className="rounded-full bg-violet-50 px-2 py-0.5 font-medium text-violet-700">✦ AI generated</span>
          <Link to={`/traces/${m.runId}`} className="font-medium text-violet-700 hover:underline">Trace ›</Link>
        </div>
      )}
    </div>
  );
}

function OrderCard({ o, ret }: { o: NonNullable<Selected["order"]>; ret: Selected["ret"] }) {
  const returning = new Set(ret?.items.map((i) => i.name) ?? []);
  return (
    <div className="flex flex-col gap-2">
      <Label>Order {o.orderNumber}</Label>
      <div className="flex flex-col gap-1.5 rounded-xl border border-gray-200 p-3 text-sm">
        {o.items.map((i) => (
          <div key={i.name} className="flex justify-between gap-3">
            <span className="min-w-0">
              {i.qty > 1 ? `${i.qty} × ` : ""}{i.name}
              {i.finalSale && <span className="ml-1 rounded bg-gray-100 px-1 text-[11px] text-gray-600">final sale</span>}
              {returning.has(i.name) && <span className="ml-1 rounded bg-amber-50 px-1 text-[11px] text-amber-800">returning</span>}
            </span>
            <span className="shrink-0 tabular-nums">{(i.price * i.qty).toLocaleString("en-US")} TRY</span>
          </div>
        ))}
        {ret && (
          <div className="mt-1 flex justify-between gap-3 border-t border-gray-200 pt-1.5 font-medium">
            <span>Refund</span>
            <span className="tabular-nums">{ret.amount.toLocaleString("en-US")} TRY</span>
          </div>
        )}
        <div className="flex justify-between gap-3 text-xs text-gray-500">
          <span>{o.status}</span>
          {o.deliveredDaysAgo !== null && <span>delivered {o.deliveredDaysAgo} days ago</span>}
        </div>
      </div>
    </div>
  );
}

function Checks({ t }: { t: Selected }) {
  const c = t.checks!;
  type Line = { tone: "ok" | "warn" | "bad" | "info"; text: string; note?: string };
  const lines: Line[] = c.items.map((i) => ({ tone: i.eligible ? "ok" : "bad", text: `${i.name}: ${i.eligible ? "eligible" : "not eligible"}`, note: i.reason }));
  if (c.approval) lines.push({ tone: "warn", text: `${c.approval.amount.toLocaleString("en-US")} TRY is above the ${c.approval.threshold.toLocaleString("en-US")} TRY limit`, note: "needs a human, so the tool paused" });
  if (c.escalated) lines.push({ tone: "info", text: "Escalated by the agent", note: t.reason });
  if (lines.length === 0) lines.push({ tone: "info", text: "No rule was checked in this run", note: "the agent handed over before looking anything up" });

  const icon = { ok: ["bg-emerald-100 text-emerald-700", "M20 6 9 17l-5-5"], bad: ["bg-red-100 text-red-700", "M6 6l12 12M18 6 6 18"], warn: ["bg-amber-100 text-amber-800", "M12 6v8M12 18h.01"], info: ["bg-sky-100 text-sky-700", "M12 8h.01M12 11v6"] } as const;
  return (
    <div className="flex flex-col gap-2">
      <Label>Checked by code</Label>
      <ul className="flex flex-col gap-1.5 text-sm">
        {lines.map((l, i) => (
          <li key={i} className="anim-rise flex gap-2" style={{ "--d": `${120 + i * 90}ms` } as React.CSSProperties}>
            <span className={`anim-pop mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full ${icon[l.tone][0]}`} style={{ "--d": `${200 + i * 90}ms` } as React.CSSProperties}>
              <svg viewBox="0 0 24 24" aria-hidden="true" className="h-2.5 w-2.5 fill-none stroke-current stroke-[3.2] [stroke-linecap:round] [stroke-linejoin:round]"><path d={icon[l.tone][1]} /></svg>
            </span>
            <span className="min-w-0">
              {l.text}
              {l.note && <span className="block text-xs text-gray-500">{l.note}</span>}
            </span>
          </li>
        ))}
      </ul>
      {c.source && <code className="text-[11px] text-gray-500">from {c.source}</code>}
    </div>
  );
}

/** Tutar çubuğu: eşik çizgisi + tutar. Eşiği geçtiyse sarı. */
function LimitBar({ amount, threshold, delayMs }: { amount: number; threshold: number; delayMs: number }) {
  const max = Math.max(amount, threshold) * 1.15;
  const over = amount > threshold;
  const lim = (threshold / max) * 100;
  return (
    <div className="flex flex-col gap-2">
      <Label>Auto-approval limit</Label>
      <div className="relative h-2 rounded-full bg-gray-100">
        <span
          className={`anim-grow-x absolute inset-y-0 left-0 rounded-full ${over ? "bg-amber-500" : "bg-emerald-500"}`}
          style={{ width: `${(amount / max) * 100}%`, "--d": `${delayMs}ms` } as React.CSSProperties}
        />
        <span aria-hidden="true" className="absolute -top-1 -bottom-1 w-0.5 bg-gray-900" style={{ left: `${lim}%` }} />
      </div>
      <div className="relative h-4 text-xs text-gray-500 tabular-nums">
        <span className="absolute -translate-x-1/2" style={{ left: `${lim}%` }}>{threshold.toLocaleString("en-US")}</span>
        <span className={`absolute right-0 ${over ? "text-amber-800" : ""}`}>{amount.toLocaleString("en-US")} TRY</span>
      </div>
    </div>
  );
}

/** Onaylarken gösterilen adımlar. Sunucu tek seferde cevap verir; adımlar bekleme süresince sırayla yanar, tik'ler sonuç gelince konur. */
const APPROVE_STEPS = ["Resuming the paused agent run", "createReturnRequest re-checks the rules", "Agent tells the customer"];

function Decide({ t }: { t: Selected }) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const pending = busy ? String(fetcher.formData?.get("decision") ?? "") : null;
  const isReturn = t.kind === "return_approval";
  const [lit, setLit] = useState(0);

  useEffect(() => {
    if (pending !== "approve" || !isReturn) return setLit(0);
    setLit(1);
    const a = setTimeout(() => setLit(2), 1200);
    const b = setTimeout(() => setLit(3), 2600);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, [pending, isReturn]);

  if (t.status !== "open") {
    const text =
      t.status === "approved"
        ? isReturn
          ? t.resolution === "resumed_run" ? "Approved. The agent resumed the paused run; the tool re-checked the rules before creating the return." : "Approved directly by code (the paused run couldn't be resumed)."
          : "Marked as handled."
        : isReturn ? "Rejected. The customer got a message from the support team." : "Dismissed.";
    return (
      <div className="flex flex-col gap-2">
        <Label>Decision</Label>
        <div className={`anim-rise rounded-xl px-3 py-2.5 text-sm ${t.status === "approved" ? "bg-emerald-50 text-emerald-900" : "bg-gray-100 text-gray-700"}`}>
          <p className="font-medium">{t.status === "approved" ? "Approved" : isReturn ? "Rejected" : "Closed"}{t.decidedAt ? ` · ${new Date(t.decidedAt).toLocaleString("en-GB")}` : ""}</p>
          <p className="mt-0.5">{text}</p>
          {t.resolutionRunId && <Link to={`/traces/${t.resolutionRunId}`} className="mt-1 inline-block font-medium underline">Approval run ›</Link>}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Label>{pending === "approve" && isReturn ? "Approving" : "Decision"}</Label>
      {pending === "approve" && isReturn ? (
        <ol className="flex flex-col gap-1.5 rounded-xl bg-sky-50 px-3 py-2.5 text-sm text-sky-900" aria-live="polite">
          {APPROVE_STEPS.map((s, i) => (
            <li key={s} className={`flex items-center gap-2 transition-opacity duration-300 ${i < lit ? "opacity-100" : "opacity-40"}`}>
              <span className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border-[1.5px] border-current ${i === lit - 1 ? "animate-spin border-r-transparent" : ""}`} />
              {s}
            </li>
          ))}
        </ol>
      ) : (
        <fetcher.Form method="post" className="flex gap-2">
          <input type="hidden" name="ticketId" value={t.id} />
          <button name="decision" value="reject" disabled={busy || t.processing} className="flex-1 rounded-full border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-50">
            {pending === "reject" ? "Saving…" : isReturn ? "Reject" : "Dismiss"}
          </button>
          <button name="decision" value="approve" disabled={busy || t.processing} className="flex-1 rounded-full bg-gray-900 px-3 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-50">
            {pending === "approve" ? "Saving…" : isReturn ? "Approve refund" : "Mark handled"}
          </button>
        </fetcher.Form>
      )}
      {isReturn && !busy && <p className="text-xs text-gray-500">Approving resumes the paused agent run. The tool checks the rules again before it creates the return.</p>}
      {t.suggestedAction && !busy && <p className="text-xs text-gray-500"><span className="font-medium text-gray-600">Suggested:</span> {t.suggestedAction}</p>}
      {fetcher.data && !fetcher.data.ok && <p className="text-sm text-red-600">{fetcher.data.message}</p>}
    </div>
  );
}

// ─── Küçük parçalar ────────────────────────────────────────────────────────

function QueueTab({ to, active, children }: { to: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link to={to} preventScrollReset className={`rounded-full px-3 py-1 ${active ? "bg-gray-100 font-medium text-gray-900" : "text-gray-500 hover:text-gray-800"}`}>
      {children}
    </Link>
  );
}

function KindChip({ kind }: { kind: "escalation" | "return_approval" }) {
  return kind === "return_approval" ? (
    <span className="rounded bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-800">Refund approval</span>
  ) : (
    <span className="rounded bg-rose-50 px-1.5 py-0.5 text-xs font-medium text-rose-700">Escalation</span>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] font-medium tracking-wide text-gray-500 uppercase">{children}</p>;
}
