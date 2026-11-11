/**
 * Bir müşteri mesajının sunucudaki yolu: mesajı kaydet → sohbet insana
 * devredildiyse dur → ajanı çalıştır → cevabı kaydet.
 *
 * /chat route'unun action'ı ve `npm run eval` bu tek fonksiyonu kullanır; böylece
 * eval, müşterinin gerçekten geçtiği yolu test eder (Express'te route handler'ı
 * ince tutup iş mantığını bir service'e almak gibi).
 */
import type { ObjectId } from "mongodb";
import { runAgent, type AgentReply } from "~/agents/run.server";
import { collections } from "./db.server";
import type { Message } from "./types";

export type SendResult =
  | { status: "not_found" }
  | { status: "escalated" } // bot cevap vermedi; mesaj temsilci için kaydedildi
  | { status: "replied"; reply: AgentReply };

export async function createConversation(): Promise<ObjectId> {
  const now = new Date();
  const { insertedId } = await collections.conversations().insertOne({ status: "bot", messages: [], createdAt: now, updatedAt: now });
  return insertedId;
}

export async function sendCustomerMessage(conversationId: ObjectId, text: string): Promise<SendResult> {
  const convos = collections.conversations();
  const customerMsg: Message = { role: "customer", text, at: new Date() };
  // $push: document'ın içindeki diziye eleman ekler (SQL'de ayrı tabloya INSERT yerine).
  const convo = await convos.findOneAndUpdate(
    { _id: conversationId },
    { $push: { messages: customerMsg }, $set: { updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  if (!convo) return { status: "not_found" };

  // Sohbet insana devredildiyse bot artık cevap vermez; temsilci Inbox'tan görür.
  if (convo.status === "escalated") return { status: "escalated" };

  const reply = await runAgent(conversationId, convo.messages);
  await convos.updateOne(
    { _id: conversationId },
    {
      $push: { messages: { role: "agent", text: reply.text, at: new Date(), runId: reply.runId } },
      $set: { updatedAt: new Date() },
    },
  );
  return { status: "replied", reply };
}
