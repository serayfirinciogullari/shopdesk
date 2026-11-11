/**
 * Inbox kararları: temsilci bir ticket'ı onaylar ya da reddeder.
 *
 * Onaylanan bekleyen iade için önce yol (a) denenir: durmuş run kaldığı yerden
 * onayla sürdürülür (`resumeApprovedReturn`), araç gerçekten çalışır ve müşteriye
 * ajanın kendisi yazar. Bu bir sebeple olmazsa (model kotası, bozuk kayıt) yol (b):
 * kod iade kaydını doğrudan onaylar ve müşteriye "Support team" mesajı ekler.
 * Hangi yolun kullanıldığı ticket'ta `resolution` olarak saklanır.
 */
import { ObjectId } from "mongodb";
import { resumeApprovedReturn } from "~/agents/run.server";
import { collections } from "./db.server";
import type { Message, Ticket } from "./types";

export type Decision = "approve" | "reject";

export interface DecisionResult {
  ok: boolean;
  message: string;
}

const LOCK_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Ticket'ı karar için kilitler (çift tıklama iki kez iade onaylamasın).
 * SQL'deki `UPDATE … WHERE status='open' AND processing_at IS NULL RETURNING *` gibi:
 * tek atomik işlem, iki istekten yalnızca biri kazanır.
 */
async function claim(id: ObjectId) {
  const stale = new Date(Date.now() - LOCK_TIMEOUT_MS);
  return collections.tickets().findOneAndUpdate(
    { _id: id, status: "open", $or: [{ processingAt: { $exists: false } }, { processingAt: { $lt: stale } }] },
    { $set: { processingAt: new Date() } },
    { returnDocument: "after" },
  );
}

async function finish(id: ObjectId, set: Partial<Ticket>) {
  await collections.tickets().updateOne({ _id: id }, { $set: { ...set, decidedAt: new Date() }, $unset: { processingAt: "" } });
}

async function release(id: ObjectId) {
  await collections.tickets().updateOne({ _id: id }, { $unset: { processingAt: "" } });
}

async function pushMessage(conversationId: ObjectId, msg: Message) {
  await collections
    .conversations()
    .updateOne({ _id: conversationId }, { $push: { messages: msg }, $set: { updatedAt: new Date() } });
}

export async function decideTicket(rawId: string, decision: Decision): Promise<DecisionResult> {
  if (!ObjectId.isValid(rawId)) return { ok: false, message: "Ticket not found." };
  const ticket = await claim(new ObjectId(rawId));
  if (!ticket?._id) return { ok: false, message: "This ticket was already decided (or is being processed)." };

  try {
    if (ticket.kind === "return_approval") {
      return decision === "approve" ? await approveReturn(ticket) : await rejectReturn(ticket);
    }
    // Escalation: iade yok, temsilci sohbeti devraldı; ticket kapanır.
    await finish(ticket._id, { status: decision === "approve" ? "approved" : "rejected", resolution: "closed" });
    return { ok: true, message: decision === "approve" ? "Ticket marked as handled." : "Ticket dismissed." };
  } catch (e) {
    console.error("[decideTicket]", e);
    await release(ticket._id);
    return { ok: false, message: `Something went wrong: ${(e as Error).message}` };
  }
}

async function approveReturn(ticket: Ticket & { _id: ObjectId }): Promise<DecisionResult> {
  if (!ticket.returnId) throw new Error("Ticket has no linked return request");
  const returns = collections.returns();
  const ret = await returns.findOne({ _id: ticket.returnId });
  if (!ret || ret.status !== "pending_approval") throw new Error(`Return request is ${ret?.status ?? "missing"}`);

  // Yol (a): kayıtlı run'ı onayla sürdür.
  let resumeError: string | undefined;
  if (ticket.runState) {
    const r = await resumeApprovedReturn({
      conversationId: ticket.conversationId,
      runState: ticket.runState,
      returnId: ticket.returnId,
      ticketId: ticket._id,
      originalRunId: ticket.runId,
      callId: ticket.pendingToolCall?.callId,
    });
    const after = await returns.findOne({ _id: ticket.returnId });
    if (after?.status === "approved") {
      // Araç çalıştı. Model metin üretemediyse bile iade onaylı; müşteriye kısa bir not düş.
      const text = r.text || "Good news: a team member approved your return. You'll get a return shipping code by email.";
      await pushMessage(ticket.conversationId, { role: "agent", text, at: new Date(), runId: r.runId });
      await finish(ticket._id, { status: "approved", resolution: "resumed_run", resolutionRunId: r.runId });
      return { ok: true, message: `Refund of ${ret.amount} TRY approved. The agent resumed the run and told the customer.` };
    }
    resumeError = `resume run ${r.runId} did not approve the return`;
  } else {
    resumeError = "no saved run state";
  }

  // Yol (b): kodda doğrudan onayla.
  const { modifiedCount } = await returns.updateOne(
    { _id: ticket.returnId, status: "pending_approval" },
    { $set: { status: "approved", decidedAt: new Date() } },
  );
  if (modifiedCount !== 1) throw new Error("Return request was decided by someone else");
  await pushMessage(ticket.conversationId, {
    role: "human",
    text: `Your return for ${ret.orderNumber} (${ret.amount} TRY) has been approved. You'll get a return shipping code by email; the refund is issued after the item arrives.`,
    at: new Date(),
  });
  await finish(ticket._id, { status: "approved", resolution: "direct_update", resolutionError: resumeError });
  return { ok: true, message: `Refund of ${ret.amount} TRY approved (direct update: ${resumeError}).` };
}

async function rejectReturn(ticket: Ticket & { _id: ObjectId }): Promise<DecisionResult> {
  if (!ticket.returnId) throw new Error("Ticket has no linked return request");
  const ret = await collections
    .returns()
    .findOneAndUpdate(
      { _id: ticket.returnId, status: "pending_approval" },
      { $set: { status: "rejected", decidedAt: new Date() } },
      { returnDocument: "after" },
    );
  if (!ret) throw new Error("Return request is no longer pending");
  await pushMessage(ticket.conversationId, {
    role: "human",
    text: `We reviewed your return request for ${ret.orderNumber} and couldn't approve it. A team member will contact you by email with the details.`,
    at: new Date(),
  });
  await finish(ticket._id, { status: "rejected", resolution: "direct_update" });
  return { ok: true, message: `Return for ${ret.orderNumber} rejected; the customer was notified.` };
}
