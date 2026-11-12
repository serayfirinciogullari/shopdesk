/**
 * Trace'i ekranda okunur hâle getiren saf fonksiyonlar (veritabanına dokunmaz).
 * Hem /traces/:runId sayfası hem sohbet ekranındaki "What the agent did" paneli kullanır,
 * böylece bir kural sonucu iki yerde aynı cümleyle görünür.
 *
 * `.server` değil: tarayıcıya da gider, sadece veri dönüştürür.
 */
import type { Span, Trace } from "./types";

export type Outcome = { tone: "good" | "bad" | "warn"; text: string };

/**
 * Bir aracın (ya da onay adımının) çıktısındaki kararı tek satırda öne çıkarır,
 * ör. "Field jacket: not eligible: Final sale item". Ham JSON trace sayfasında yine duruyor.
 */
export function describeOutcome(s: { type: Span["type"]; output?: unknown }): Outcome[] {
  const o = s.output as Record<string, any> | undefined;
  if (!o || typeof o !== "object") return [];
  if (s.type === "approval") {
    if (o.status === "pending_human_approval")
      return [{ tone: "warn", text: `Paused for human approval: ${o.amount} TRY is above the ${o.threshold} TRY limit. Tool did not run.` }];
    if (o.status === "approved_by_human") return [{ tone: "good", text: "Approved by a team member in the Inbox. Resuming the paused run." }];
    return [{ tone: "bad", text: `Not executed: ${o.reason ?? o.status}` }];
  }
  const out: Outcome[] = [];
  if (o.found === false) out.push({ tone: "bad", text: `No matching order: ${o.reason}` });
  if (Array.isArray(o.items) && o.items.some((i: any) => typeof i?.eligible === "boolean")) {
    for (const i of o.items) out.push({ tone: i.eligible ? "good" : "bad", text: `${i.name}: ${i.eligible ? "eligible" : "not eligible"}: ${i.reason}` });
  }
  if (o.created === true) out.push({ tone: "good", text: `Return ${o.status}: ${o.refund}${o.approvedBy ? ` (approved by ${o.approvedBy})` : ""}` });
  if (o.created === false && o.found !== false)
    out.push({ tone: "bad", text: `Return not created: ${o.reason}${Array.isArray(o.problems) ? ` ${o.problems.join("; ")}` : ""}` });
  if (o.escalated === true) out.push({ tone: "warn", text: "Handed to a human (ticket opened)." });
  if (o.found === true && typeof o.status === "string" && !o.items?.[0]?.sku) out.push({ tone: "good", text: `Order ${o.orderNumber}: ${o.status}` });
  return out;
}

export type RunStepKind = "customer" | "agent" | "handoff" | "tool" | "approval" | "reply" | "error";

export interface RunStep {
  kind: RunStepKind;
  label: string;
  /** Run başından itibaren geçen süre (ms). */
  offsetMs: number;
  outcomes: Outcome[];
}

export interface RunSummary {
  runId: string;
  status: Trace["status"];
  interrupted: boolean;
  durationMs: number;
  modelCalls: number;
  totalTokens: number;
  fellBack: boolean;
  steps: RunStep[];
}

/**
 * Run'ı "ajan ne yaptı" listesine çevirir. Model çağrıları tek tek gösterilmez
 * (müşteri tarafında gürültü); sayıları özet satırında durur.
 */
export function summarizeRun(t: Pick<Trace, "runId" | "status" | "interrupted" | "resumedFrom" | "startedAt" | "durationMs" | "usage" | "spans" | "lastAgent" | "error">): RunSummary {
  const t0 = new Date(t.startedAt).getTime();
  const at = (d: Date) => Math.max(0, new Date(d).getTime() - t0);
  const steps: RunStep[] = [{ kind: "customer", label: t.resumedFrom ? "Inbox decision" : "Customer message", offsetMs: 0, outcomes: [] }];

  for (const s of t.spans) {
    if (s.type === "model" || s.type === "guardrail") continue;
    const label = s.type === "agent" ? `Agent · ${s.name}` : s.type === "handoff" ? `Handoff ${s.name}` : s.name;
    steps.push({ kind: s.type, label, offsetMs: at(s.startedAt), outcomes: describeOutcome(s) });
  }

  if (t.status === "error") steps.push({ kind: "error", label: "Run failed; the customer got a polite error", offsetMs: t.durationMs, outcomes: [] });
  else if (t.interrupted) steps.push({ kind: "reply", label: "Reply sent · waiting for a team member", offsetMs: t.durationMs, outcomes: [] });
  else steps.push({ kind: "reply", label: `Reply sent${t.lastAgent ? ` by ${t.lastAgent}` : ""}`, offsetMs: t.durationMs, outcomes: [] });

  return {
    runId: t.runId,
    status: t.status,
    interrupted: !!t.interrupted,
    durationMs: t.durationMs,
    modelCalls: t.usage.requests,
    totalTokens: t.usage.totalTokens,
    fellBack: t.spans.some((s) => s.type === "model" && !!s.fallbackReason),
    steps,
  };
}

export function fmtMs(ms: number) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
}
