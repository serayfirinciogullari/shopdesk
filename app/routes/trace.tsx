/**
 * /traces/:runId: bir run'ın incelemesi ("ajan ne yaptı, neden?").
 *
 * Bir run = bir müşteri mesajı. `traces` collection'ında run başına tek document var
 * ve adımları (`spans`) içinde dizi olarak duruyor; PostgreSQL'de bunu bir `traces`
 * tablosu + bir `spans` tablosu ve JOIN ile yapardık, burada tek okuma yetiyor.
 *
 * Düzen lookfor'un trace inspector'ı gibi: en üstte karar (ne oldu?), solda adım listesi
 * ve süre çubukları, sağda seçilen adımın ayrıntısı. Seçili adım URL'de (`?step=6`),
 * yani link paylaşılınca aynı adım açılır.
 */
import { data, Link, useSearchParams } from "react-router";
import type { Route } from "./+types/trace";
import { collections } from "~/lib/db.server";
import type { Span } from "~/lib/types";
import { AgentText } from "~/components/AgentText";
import { TicketPill } from "~/components/ui";
import { describeOutcome, fmtMs, RULE_SOURCE, runVerdict, type RunVerdict } from "~/lib/trace-view";

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
    verdict: runVerdict(t),
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

type LoaderData = Route.ComponentProps["loaderData"];
type UISpan = LoaderData["spans"][number];

/** Listede gösterilen satır: trace'in span'ları + baştaki müşteri mesajı ve sondaki cevap. */
type Row =
  | { kind: "input"; label: string; offsetMs: number; durationMs: number; level: 0 }
  | { kind: "span"; span: UISpan; label: string; offsetMs: number; durationMs: number; level: 0 | 1 }
  | { kind: "output"; label: string; offsetMs: number; durationMs: number; level: 0 };

const TYPE_STYLE: Record<Span["type"], { label: string; chip: string; bar: string }> = {
  agent: { label: "Agent", chip: "bg-violet-50 text-violet-700", bar: "bg-violet-500" },
  handoff: { label: "Handoff", chip: "bg-violet-50 text-violet-700", bar: "bg-violet-300" },
  model: { label: "Model", chip: "bg-gray-100 text-gray-600", bar: "bg-gray-300" },
  tool: { label: "Function", chip: "bg-emerald-50 text-emerald-700", bar: "bg-emerald-500" },
  approval: { label: "Approval", chip: "bg-amber-50 text-amber-800", bar: "bg-amber-500" },
  guardrail: { label: "Guardrail", chip: "bg-rose-50 text-rose-700", bar: "bg-rose-500" },
};

const TONE = {
  good: "bg-emerald-50 text-emerald-800",
  bad: "bg-red-50 text-red-800",
  warn: "bg-amber-50 text-amber-900",
};

function buildRows(t: LoaderData): Row[] {
  const rows: Row[] = [{ kind: "input", label: t.resumedFrom ? "Inbox decision" : "Customer message", offsetMs: 0, durationMs: 0, level: 0 }];
  for (const s of t.spans) {
    // Model, araç ve onay adımları bir ajanın içinde olur: bir kademe içeride.
    const level = s.type === "agent" || s.type === "handoff" ? 0 : 1;
    rows.push({ kind: "span", span: s, label: s.type === "model" ? "Generation" : s.name, offsetMs: s.offsetMs, durationMs: s.durationMs, level });
  }
  rows.push({ kind: "output", label: t.status === "error" ? "Error" : `Reply${t.lastAgent ? ` · ${t.lastAgent}` : ""}`, offsetMs: t.durationMs, durationMs: 0, level: 0 });
  return rows;
}

/** Açılışta seçili adım: kuralın karar verdiği araç (ret varsa o), yoksa ilk araç, yoksa cevap. */
function defaultStep(rows: Row[]) {
  const spanRows = rows.map((r, i) => [r, i] as const).filter(([r]) => r.kind === "span" && (r.span.type === "tool" || r.span.type === "approval"));
  const refused = spanRows.find(([r]) => r.kind === "span" && describeOutcome(r.span).some((o) => o.tone !== "good"));
  return (refused ?? spanRows[0])?.[1] ?? rows.length - 1;
}

export default function TracePage({ loaderData: t }: Route.ComponentProps) {
  const rows = buildRows(t);
  const [params, setParams] = useSearchParams();
  const raw = Number(params.get("step"));
  const selected = Number.isInteger(raw) && raw >= 0 && raw < rows.length && params.has("step") ? raw : defaultStep(rows);
  const select = (i: number) =>
    setParams((p) => { p.set("step", String(i)); return p; }, { replace: true, preventScrollReset: true });

  const total = Math.max(t.durationMs, 1);
  const fellBack = t.spans.some((s) => s.type === "model" && s.fallbackReason);
  const toolCalls = t.spans.filter((s) => s.type === "tool").length;
  // Çubuklar run'daki gerçek başlangıç sırasıyla çizilir (gerçek sürenin ~0,4'ü, en fazla 1,2 sn).
  const barDelay = (offsetMs: number) => Math.min(1200, Math.round(offsetMs * 0.4));

  return (
    <main className="page pt-4 pb-16">

      <header className="mt-4 flex flex-col gap-3 rounded-2xl border border-gray-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500">
          <Link to={`/chat/${t.conversationId}`} className="hover:text-gray-800 hover:underline">Conversation</Link>
          <span>›</span>
          <code className="text-gray-700">{t.runId}</code>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold">{t.resumedFrom ? "Run resumed after approval" : "Run"}</h1>
          <StatusPill status={t.status} interrupted={t.interrupted} />
          {t.lastAgent && <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">ended in {t.lastAgent}</span>}
        </div>

        <Verdict v={t.verdict} delayMs={barDelay(t.durationMs) + 300} />

        <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm tabular-nums">
          <Stat label="Duration" value={fmtMs(t.durationMs)} />
          <Stat label="Model calls" value={String(t.usage.requests)} />
          <Stat label="Tokens" value={t.usage.totalTokens.toLocaleString("en-US")} hint={`${t.usage.inputTokens} in · ${t.usage.outputTokens} out`} />
          <Stat label="Tool calls" value={String(toolCalls)} />
          <Stat label="Started" value={new Date(t.startedAt).toLocaleTimeString("en-GB")} hint={new Date(t.startedAt).toLocaleDateString("en-GB")} />
        </dl>
        {fellBack && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Some model calls fell back from the primary provider (marked in the list). The customer never saw this.
          </p>
        )}
        {(t.resumedFrom || t.continuedIn) && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {t.resumedFrom && <Link to={`/traces/${t.resumedFrom}`} className="text-gray-600 underline">← Paused run this one resumed</Link>}
            {t.continuedIn && <Link to={`/traces/${t.continuedIn}`} className="text-gray-600 underline">Resumed after approval →</Link>}
          </div>
        )}
      </header>

      <div className="mt-4 grid overflow-hidden rounded-2xl border border-gray-200 bg-white lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <section aria-label="Steps" className="min-w-0 border-b border-gray-200 py-2 lg:border-r lg:border-b-0">
          <div className="grid grid-cols-[minmax(0,1fr)_140px] gap-3 px-4 pb-2 text-xs text-gray-500">
            <span>Step</span>
            <span>Timeline · 0 → {fmtMs(t.durationMs)}</span>
          </div>
          <ol>
            {rows.map((r, i) => (
              <li key={i}>
                <StepRow row={r} selected={i === selected} total={total} delayMs={barDelay(r.offsetMs)} onSelect={() => select(i)} />
              </li>
            ))}
          </ol>
        </section>

        {/* key: adım değişince panel kısa bir girişle yenilenir. */}
        <section key={selected} aria-live="polite" className="anim-rise min-w-0 p-4" style={{ "--d": "0ms" } as React.CSSProperties}>
          <Detail row={rows[selected]} t={t} />
        </section>
      </div>

      {t.tickets.length > 0 && (
        <section className="mt-4 rounded-2xl border border-gray-200 bg-white p-4 text-sm">
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

// ─── Parçalar ──────────────────────────────────────────────────────────────

function Verdict({ v, delayMs }: { v: RunVerdict; delayMs: number }) {
  const cls = {
    good: "border-emerald-600 bg-emerald-50 text-emerald-900",
    bad: "border-red-600 bg-red-50 text-red-900",
    warn: "border-amber-500 bg-amber-50 text-amber-900",
    neutral: "border-gray-300 bg-gray-50 text-gray-800",
  }[v.tone];
  return (
    <div className={`anim-rise rounded-xl border-[1.5px] px-3 py-2.5 text-sm ${cls}`} style={{ "--d": `${delayMs}ms` } as React.CSSProperties}>
      <p className="font-medium">{v.title}</p>
      {v.detail && <p className="mt-0.5 opacity-80">{v.detail}</p>}
    </div>
  );
}

function StepRow({ row, selected, total, delayMs, onSelect }: { row: Row; selected: boolean; total: number; delayMs: number; onSelect: () => void }) {
  const style = row.kind === "span" ? TYPE_STYLE[row.span.type] : { label: row.kind === "input" ? "Input" : "Output", chip: "bg-sky-50 text-sky-700", bar: "bg-gray-900" };
  const outcomes = row.kind === "span" ? describeOutcome(row.span) : [];
  const flag = outcomes.find((o) => o.tone === "bad") ? "refused" : outcomes.find((o) => o.tone === "warn") ? "needs a human" : null;
  const fallback = row.kind === "span" && row.span.fallbackReason;
  const left = (row.offsetMs / total) * 100;
  const width = Math.max(0.6, (row.durationMs / total) * 100);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`grid w-full grid-cols-[minmax(0,1fr)_140px] items-center gap-3 px-4 py-1.5 text-left text-sm transition-colors ${selected ? "bg-violet-50" : "hover:bg-gray-50"}`}
    >
      <span className="flex min-w-0 items-center gap-2" style={{ paddingLeft: row.level * 16 }}>
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${style.chip}`}>{style.label}</span>
        <span className={`truncate ${row.kind === "span" && row.span.type === "tool" ? "font-mono text-[13px]" : ""} ${row.kind === "span" && row.span.type === "model" ? "text-gray-500" : ""}`}>
          {row.label}
        </span>
        {flag && <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[11px] ${flag === "refused" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-800"}`}>{flag}</span>}
        {fallback && <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">fallback</span>}
      </span>
      <span className="relative h-2.5 rounded bg-gray-100" title={`+${fmtMs(row.offsetMs)} · ${fmtMs(row.durationMs)}`}>
        <i
          className={`anim-grow-x absolute inset-y-0 rounded ${style.bar}`}
          style={{ left: `min(${left}%, calc(100% - 3px))`, width: `${width}%`, minWidth: 3, "--d": `${delayMs}ms` } as React.CSSProperties}
        />
      </span>
    </button>
  );
}

function Detail({ row, t }: { row: Row; t: LoaderData }) {
  if (row.kind === "input") {
    return (
      <DetailShell title={row.label} chip="Input" offsetMs={0}>
        <p className="whitespace-pre-wrap rounded-lg bg-gray-50 p-3 text-sm">{t.input}</p>
      </DetailShell>
    );
  }
  if (row.kind === "output") {
    return (
      <DetailShell title={row.label} chip="Output" offsetMs={t.durationMs}>
        {t.status === "error" ? (
          <p className="text-sm text-red-700">{t.error}</p>
        ) : (
          <p className="whitespace-pre-wrap rounded-lg bg-gray-50 p-3 text-sm"><AgentText text={t.finalOutput ?? ""} /></p>
        )}
        <p className="text-xs text-gray-500">This is what the customer saw. The checks above it come from the tools, not from this text.</p>
      </DetailShell>
    );
  }

  const s = row.span;
  const outcomes = describeOutcome(s);
  const rule = s.type === "tool" ? RULE_SOURCE[s.name] : s.type === "approval" ? { where: "createReturnRequest › needsApproval", rule: "Refunds above 1,000 TRY pause the run until a team member decides." } : undefined;
  return (
    <DetailShell title={row.label} chip={TYPE_STYLE[s.type].label} offsetMs={s.offsetMs} durationMs={s.durationMs} mono={s.type === "tool"}>
      {s.type === "model" && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
          <dt className="text-gray-500">Provider</dt>
          <dd className="min-w-0 break-words">{s.provider}/{s.model}</dd>
          {s.tokens && (
            <>
              <dt className="text-gray-500">Tokens</dt>
              <dd className="tabular-nums">{s.tokens.total} ({s.tokens.input} in, {s.tokens.output} out)</dd>
            </>
          )}
          {s.fallbackReason && (
            <>
              <dt className="text-gray-500">Fallback</dt>
              <dd className="text-amber-800">{s.fallbackReason}</dd>
            </>
          )}
        </dl>
      )}
      {s.type === "handoff" && <p className="text-sm text-gray-600">The conversation moved to another agent. Earlier tool messages are filtered out on the way (removeAllTools), so the new agent has to call its own tools instead of guessing.</p>}
      {s.type === "agent" && <p className="text-sm text-gray-600">The {s.name} agent started. The model, tool and approval steps below it belong to this agent.</p>}

      {outcomes.length > 0 && (
        <ul className="flex flex-col gap-1">
          {outcomes.map((o, i) => (
            <li key={i} className={`anim-pop rounded-lg px-2.5 py-1.5 text-sm ${TONE[o.tone]}`} style={{ "--d": `${120 + i * 100}ms` } as React.CSSProperties}>
              {o.text}
            </li>
          ))}
        </ul>
      )}
      {rule && (
        <div className="rounded-lg border border-violet-300 bg-violet-50 px-3 py-2 text-sm text-violet-900">
          <p className="font-medium">Rule enforced in code</p>
          <p className="mt-0.5">{rule.rule}</p>
          <code className="mt-1 block text-xs text-violet-700">{rule.where}</code>
        </div>
      )}
      {s.error && <p className="text-sm text-red-700">Error: {s.error}</p>}
      <Json label="Input" value={s.input} />
      <Json label="Output" value={s.output} />
    </DetailShell>
  );
}

function DetailShell({ title, chip, offsetMs, durationMs, mono, children }: { title: string; chip: string; offsetMs: number; durationMs?: number; mono?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium text-gray-600">{chip}</span>
        <h2 className={`min-w-0 break-words font-semibold ${mono ? "font-mono text-sm" : ""}`}>{title}</h2>
        <span className="ml-auto font-mono text-xs text-gray-400">
          +{fmtMs(offsetMs)}{durationMs ? ` · ${fmtMs(durationMs)}` : ""}
        </span>
      </div>
      {children}
    </div>
  );
}

function Json({ label, value }: { label: string; value: unknown }) {
  if (value === undefined) return null;
  return (
    <div className="text-xs">
      <p className="text-gray-500">{label}</p>
      <pre className="mt-1 max-h-80 overflow-auto rounded-lg bg-gray-50 p-2 text-[11px] leading-relaxed text-gray-800">{JSON.stringify(value, null, 2)}</pre>
    </div>
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
