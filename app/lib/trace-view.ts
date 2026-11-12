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

export interface RunVerdict {
  tone: "good" | "bad" | "warn" | "neutral";
  title: string;
  detail?: string;
}

/**
 * Run'ın tek cümlelik sonucu, trace sayfasının en üstünde. Modelin cevap metnine değil,
 * araçların ne döndürdüğüne bakar (eval'deki kontroller gibi): "ne dedi" değil "ne oldu".
 */
export function runVerdict(t: Pick<Trace, "status" | "error" | "spans">): RunVerdict {
  if (t.status === "error") return { tone: "bad", title: "The run failed.", detail: t.error ?? "The customer got a polite error message." };

  const out = (s: Span) => (s.output ?? {}) as Record<string, any>;
  const tools = t.spans.filter((s) => s.type === "tool");
  const approvals = t.spans.filter((s) => s.type === "approval");
  const called = (name: string) => tools.some((s) => s.name === name);

  const created = tools.find((s) => s.name === "createReturnRequest" && out(s).created === true);
  if (created) {
    const byHuman = approvals.some((s) => out(s).status === "approved_by_human");
    return { tone: "good", title: `Return created: ${out(created).refund}.`, detail: byHuman ? "Approved by a team member in the Inbox; the tool re-checked the rules before creating it." : "Under the 1,000 TRY limit, so no human approval was needed." };
  }
  const paused = approvals.find((s) => out(s).status === "pending_human_approval");
  if (paused) {
    const o = out(paused);
    return { tone: "warn", title: `Paused for human approval: ${o.amount} TRY is above the ${o.threshold} TRY limit.`, detail: "createReturnRequest did not run. The run waits in the Inbox." };
  }
  if (tools.some((s) => s.name === "escalateToHuman" && out(s).escalated === true))
    return { tone: "warn", title: "Handed to a human.", detail: "A ticket was opened in the Inbox and the bot stopped replying in this chat." };

  const refused = tools.flatMap((s) => (Array.isArray(out(s).items) ? out(s).items : [])).filter((i: any) => i?.eligible === false);
  if (refused.length) {
    const first = refused[0] as { name: string; reason: string };
    return {
      tone: "bad",
      title: `Refused by rule: ${first.name}: ${first.reason}`,
      detail: `${refused.length > 1 ? `${refused.length} items were refused. ` : ""}${called("createReturnRequest") ? "createReturnRequest refused it too." : "createReturnRequest was never called."}`,
    };
  }
  const notCreated = tools.find((s) => s.name === "createReturnRequest" && out(s).created === false);
  if (notCreated) return { tone: "bad", title: `Return not created: ${out(notCreated).reason}` };
  if (tools.some((s) => out(s).found === false))
    return { tone: "bad", title: "No order data shared: the order number and email didn't match.", detail: "The tool gives the same answer for a wrong number and a wrong email, so it doesn't reveal which orders exist." };
  const found = tools.find((s) => s.name === "getOrderStatus" && out(s).found === true);
  if (found) return { tone: "good", title: `Order ${out(found).orderNumber}: ${out(found).status}.`, detail: "The number and email matched, so the tool shared the status." };
  if (tools.length === 0) return { tone: "neutral", title: "No tool was called.", detail: "The agent answered or asked a question without looking anything up." };
  return { tone: "neutral", title: `${tools.length} tool call${tools.length > 1 ? "s" : ""}, no rule decision.` };
}

/** Hangi araç hangi kuralı kodda uyguluyor (trace detayındaki "Rule enforced in code" kutusu). */
export const RULE_SOURCE: Record<string, { where: string; rule: string }> = {
  getOrderStatus: { where: "tools.server.ts › lookup()", rule: "Order number and email must both match; a wrong number and a wrong email get the same answer." },
  checkReturnEligibility: { where: "tools.server.ts › evaluateReturn()", rule: "Delivered, within 30 days, not final sale, no existing return for the item." },
  createReturnRequest: { where: "tools.server.ts › planReturn() + needsApproval", rule: "Re-checks eligibility, computes the amount in code, and needs a human above 1,000 TRY." },
  escalateToHuman: { where: "tools.server.ts › escalateToHuman", rule: "Opens a ticket and stops the bot in this conversation." },
};

export function fmtMs(ms: number) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
}
