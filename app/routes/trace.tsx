/**
 * /traces/:runId: bir run'ın zaman çizelgesi ("ajan ne yaptı, neden?").
 *
 * Bir run = bir müşteri mesajı. `traces` collection'ında run başına tek document var
 * ve adımları (`spans`) içinde dizi olarak duruyor; PostgreSQL'de bunu bir `traces`
 * tablosu + bir `spans` tablosu ve JOIN ile yapardık, burada tek okuma yetiyor.
 */
import { data, Link } from "react-router";
import type { Route } from "./+types/trace";
import { collections } from "~/lib/db.server";
import type { Span } from "~/lib/types";
import { Nav, TicketPill } from "~/components/ui";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `Trace ${params.runId.slice(0, 8)} · ShopDesk` }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const t = await collections.traces().findOne({ runId: params.runId });
  if (!t) throw data("Trace not found", { status: 404 });

  // Bu run'dan açılan ticket'lar (ör. onay bekleyen iade) ve onlar sonra ne oldu?
  const tickets = await collections.tickets().find({ runId: t.runId }).toArray();
  // Bu run, Inbox onayıyla sürdürülen bir run'ın devamıysa ya da devamı varsa: zinciri bağla.
  const continuation = await collections.traces().findOne({ resumedFrom: t.runId }, { projection: { runId: 1 } });

  const t0 = t.startedAt.getTime();
  return {
    runId: t.runId,
    conversationId: t.conversationId.toHexString(),
    input: t.input,
    finalOutput: t.finalOutput ?? null,
    lastAgent: t.lastAgent ?? null,
    status: t.status,
    error: t.error ?? null,
    interrupted: !!t.interrupted,
    resumedFrom: t.resumedFrom ?? null,
    continuedIn: continuation?.runId ?? null,
    startedAt: t.startedAt.toISOString(),
    durationMs: t.durationMs,
    usage: t.usage,
    tickets: tickets.map((k) => ({
      id: k._id.toHexString(),
      kind: k.kind,
      status: k.status,
      resolution: k.resolution ?? null,
      resolutionRunId: k.resolutionRunId ?? null,
    })),
    spans: t.spans.map((s) => ({
      ...s,
      startedAt: s.startedAt.toISOString(),
      offsetMs: Math.max(0, s.startedAt.getTime() - t0),
    })),
  };
}

type UISpan = Route.ComponentProps["loaderData"]["spans"][number];

export default function TracePage({ loaderData: t }: Route.ComponentProps) {
  const models = t.spans.filter((s) => s.type === "model");
  const fellBack = models.some((s) => s.fallbackReason);

  return (
    <main className="mx-auto max-w-3xl p-4 pb-16">
      <Nav />

      <header className="mt-4 rounded-xl border border-gray-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold">Run</h1>
          <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">{t.runId}</code>
          <StatusPill status={t.status} interrupted={t.interrupted} />
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Stat label="Duration" value={fmtMs(t.durationMs)} />
          <Stat label="Model calls" value={String(t.usage.requests)} />
          <Stat label="Tokens" value={t.usage.totalTokens.toLocaleString("en-US")} hint={`${t.usage.inputTokens} in · ${t.usage.outputTokens} out`} />
          <Stat label="Started" value={new Date(t.startedAt).toLocaleTimeString("en-GB")} hint={new Date(t.startedAt).toLocaleDateString("en-GB")} />
        </dl>
        {fellBack && (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Some model calls fell back from the primary provider (see the model steps). The customer never saw this.
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <Link to={`/chat/${t.conversationId}`} className="text-gray-600 underline">Open conversation</Link>
          {t.resumedFrom && (
            <Link to={`/traces/${t.resumedFrom}`} className="text-gray-600 underline">← Paused run this one resumed</Link>
          )}
          {t.continuedIn && (
            <Link to={`/traces/${t.continuedIn}`} className="text-gray-600 underline">Resumed after approval →</Link>
          )}
        </div>
      </header>

      <ol className="relative mt-6 space-y-3 border-l-2 border-gray-200 pl-5">
        <Step dot="bg-gray-900" title={t.resumedFrom ? "Inbox decision" : "Customer"} meta="0 ms">
          <p className="whitespace-pre-wrap text-sm">{t.input}</p>
        </Step>

        {t.spans.map((s, i) => (
          <SpanStep key={i} s={s} />
        ))}

        {t.status === "error" ? (
          <Step dot="bg-red-600" title="Error" meta={fmtMs(t.durationMs)}>
            <p className="text-sm text-red-700">{t.error}</p>
          </Step>
        ) : (
          <Step dot="bg-gray-900" title={`Reply${t.lastAgent ? ` · ${t.lastAgent}` : ""}`} meta={fmtMs(t.durationMs)}>
            <p className="whitespace-pre-wrap text-sm">{t.finalOutput}</p>
          </Step>
        )}
      </ol>

      {t.tickets.length > 0 && (
        <section className="mt-6 rounded-xl border border-gray-200 bg-white p-4 text-sm">
          <h2 className="font-semibold">Tickets opened by this run</h2>
          <ul className="mt-2 space-y-1">
            {t.tickets.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-2">
                <span className="text-gray-600">{k.kind === "return_approval" ? "Refund approval" : "Escalation"}</span>
                <TicketPill status={k.status} />
                {k.resolution === "resumed_run" && k.resolutionRunId && (
                  <Link to={`/traces/${k.resolutionRunId}`} className="underline">resumed run →</Link>
                )}
                {k.resolution === "direct_update" && <span className="text-gray-500">applied directly by code</span>}
                {k.status === "open" && <Link to="/inbox" className="underline">open in Inbox →</Link>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

// ─── Adımlar ───────────────────────────────────────────────────────────────

const TYPE_STYLE: Record<Span["type"], { dot: string; label: string; chip: string }> = {
  agent: { dot: "bg-indigo-600", label: "Agent", chip: "bg-indigo-50 text-indigo-700" },
  handoff: { dot: "bg-violet-500", label: "Handoff", chip: "bg-violet-50 text-violet-700" },
  model: { dot: "bg-gray-400", label: "Model", chip: "bg-gray-100 text-gray-600" },
  tool: { dot: "bg-emerald-600", label: "Tool", chip: "bg-emerald-50 text-emerald-700" },
  approval: { dot: "bg-amber-500", label: "Approval", chip: "bg-amber-50 text-amber-800" },
  guardrail: { dot: "bg-rose-500", label: "Guardrail", chip: "bg-rose-50 text-rose-700" },
};

function SpanStep({ s }: { s: UISpan }) {
  const style = TYPE_STYLE[s.type];
  const meta = `+${fmtMs(s.offsetMs)}${s.durationMs ? ` · ${fmtMs(s.durationMs)}` : ""}`;
  const title = (
    <span className="flex flex-wrap items-center gap-2">
      <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${style.chip}`}>{style.label}</span>
      <span className={s.type === "model" ? "text-gray-600" : "font-medium"}>{s.name}</span>
    </span>
  );

  if (s.type === "model") {
    return (
      <Step dot={style.dot} title={title} meta={meta} compact>
        <p className="text-xs text-gray-500">
          {s.provider}/{s.model}
          {s.tokens && ` · ${s.tokens.total} tokens (${s.tokens.input} in, ${s.tokens.output} out)`}
          {s.fallbackReason && <span className="ml-1 rounded bg-amber-100 px-1 text-amber-800">fallback: {s.fallbackReason}</span>}
          {s.error && <span className="ml-1 text-red-600">error: {s.error}</span>}
        </p>
      </Step>
    );
  }

  if (s.type === "agent" || s.type === "handoff") {
    return <Step dot={style.dot} title={title} meta={meta} compact />;
  }

  // tool / approval / guardrail: girdi, çıktı ve öne çıkan karar.
  const verdicts = describeOutcome(s);
  return (
    <Step dot={style.dot} title={title} meta={meta}>
      {verdicts.length > 0 && (
        <ul className="mb-2 space-y-1">
          {verdicts.map((v, i) => (
            <li key={i} className={`rounded-md px-2 py-1 text-sm ${v.tone === "bad" ? "bg-red-50 text-red-800" : v.tone === "warn" ? "bg-amber-50 text-amber-900" : "bg-emerald-50 text-emerald-800"}`}>
              {v.text}
            </li>
          ))}
        </ul>
      )}
      {s.error && <p className="mb-2 text-sm text-red-700">Error: {s.error}</p>}
      <Json label="Input" value={s.input} />
      <Json label="Output" value={s.output} />
    </Step>
  );
}

type Outcome = { tone: "good" | "bad" | "warn"; text: string };

/**
 * Çıktıdaki kararı tek satırda öne çıkarır (ör. "Field jacket: not eligible — Final sale item").
 * Ham JSON yine altta duruyor; bu sadece okumayı kolaylaştırır.
 */
function describeOutcome(s: UISpan): Outcome[] {
  const o = s.output as Record<string, any> | undefined;
  if (!o || typeof o !== "object") return [];
  if (s.type === "approval") {
    if (o.status === "pending_human_approval") return [{ tone: "warn", text: `Paused for human approval: ${o.amount} TRY is above the ${o.threshold} TRY limit. Tool did not run.` }];
    if (o.status === "approved_by_human") return [{ tone: "good", text: "Approved by a team member in the Inbox. Resuming the paused run." }];
    return [{ tone: "bad", text: `Not executed: ${o.reason ?? o.status}` }];
  }
  const out: Outcome[] = [];
  if (o.found === false) out.push({ tone: "bad", text: `No matching order: ${o.reason}` });
  if (Array.isArray(o.items) && o.items.some((i: any) => typeof i?.eligible === "boolean")) {
    for (const i of o.items) out.push({ tone: i.eligible ? "good" : "bad", text: `${i.name}: ${i.eligible ? "eligible" : "not eligible"}: ${i.reason}` });
  }
  if (o.created === true) out.push({ tone: "good", text: `Return ${o.status}: ${o.refund}${o.approvedBy ? ` (approved by ${o.approvedBy})` : ""}` });
  if (o.created === false && o.found !== false) out.push({ tone: "bad", text: `Return not created: ${o.reason}${Array.isArray(o.problems) ? ` ${o.problems.join("; ")}` : ""}` });
  if (o.escalated === true) out.push({ tone: "warn", text: "Handed to a human (ticket opened)." });
  if (o.found === true && typeof o.status === "string" && !o.items?.[0]?.sku) out.push({ tone: "good", text: `Order ${o.orderNumber}: ${o.status}` });
  return out;
}

// ─── Küçük parçalar ────────────────────────────────────────────────────────

function Step({ dot, title, meta, children, compact }: { dot: string; title: React.ReactNode; meta: string; children?: React.ReactNode; compact?: boolean }) {
  return (
    <li className="relative">
      <span className={`absolute -left-[27px] top-2 h-3 w-3 rounded-full ring-4 ring-gray-50 ${dot}`} />
      <div className={compact ? "py-1" : "rounded-xl border border-gray-200 bg-white p-3"}>
        <div className="flex items-start justify-between gap-3 text-sm">
          <div className="min-w-0">{title}</div>
          <span className="shrink-0 font-mono text-xs text-gray-400">{meta}</span>
        </div>
        {children && <div className="mt-1.5">{children}</div>}
      </div>
    </li>
  );
}

function Json({ label, value }: { label: string; value: unknown }) {
  if (value === undefined) return null;
  return (
    <details className="group text-xs">
      <summary className="cursor-pointer select-none text-gray-500 hover:text-gray-800">{label}</summary>
      <pre className="mt-1 max-h-80 overflow-auto rounded-lg bg-gray-50 p-2 text-[11px] leading-relaxed text-gray-800">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="font-medium">{value}</dd>
      {hint && <dd className="text-xs text-gray-400">{hint}</dd>}
    </div>
  );
}

function StatusPill({ status, interrupted }: { status: "ok" | "error"; interrupted: boolean }) {
  if (status === "error") return <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700">error</span>;
  return (
    <>
      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">ok</span>
      {interrupted && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">paused for approval</span>}
    </>
  );
}

function fmtMs(ms: number) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
}
