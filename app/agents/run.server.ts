/**
 * Ajanları kurar ve bir müşteri mesajı için bir run çalıştırır.
 *
 * Aşama 1: tek ajan (Orders). Aşama 2'de Triage + Returns ve handoff eklenecek;
 * handoff'larda `removeAllTools` filtresi kullanılacak (DEVIR_NOTU 14).
 */
import { Agent, Runner, assistant, user, type AgentInputItem } from "@openai/agents";
import type { ObjectId } from "mongodb";
import { FallbackModel } from "~/lib/llm.server";
import { RunRecorder } from "~/lib/trace.server";
import type { Message } from "~/lib/types";
import { getOrderStatus } from "./tools.server";

const ORDERS_INSTRUCTIONS = `You are the order-status assistant of ShopDesk, an online clothing store.
- To look up an order you need BOTH the order number and the email used for the order. If either is missing, ask for it. Never guess or invent them.
- Only share order details that getOrderStatus returned with found: true. If found is false, say you couldn't find a matching order and ask the customer to check the number and email. Never hint whether the order number exists.
- Never make up statuses, dates or tracking links.
- Write the WHOLE reply in the language of the customer's latest message (e.g. all Turkish if they wrote Turkish). 1-3 short sentences, friendly and plain.`;

// Ajanlar her run'da yeniden kurulur (ucuz bir işlem): model sarmalayıcısı o run'ın
// kayıt defterini tutsun, eşzamanlı sohbetler birbirine karışmasın diye.
function buildAgents(recorder: RunRecorder) {
  const orders = new Agent({
    name: "Orders",
    model: new FallbackModel(recorder, "Orders"),
    instructions: ORDERS_INSTRUCTIONS,
    tools: [getOrderStatus],
  });
  return { entry: orders };
}

function toAgentInput(messages: Message[]): AgentInputItem[] {
  return messages.map((m) => (m.role === "customer" ? user(m.text) : assistant(m.text)));
}

export interface AgentReply {
  text: string;
  runId: string;
  ok: boolean;
}

const FRIENDLY_ERROR = "Sorry, I can't answer right now. Please try again in a minute.";

/** `history` müşterinin son mesajını da içerir. */
export async function runAgent(conversationId: ObjectId, history: Message[]): Promise<AgentReply> {
  const recorder = new RunRecorder();
  const { entry } = buildAgents(recorder);
  const lastCustomerText = [...history].reverse().find((m) => m.role === "customer")?.text ?? "";

  // Runner: SDK'nın ajan döngüsünü çalıştıran motor. Olaylarını dinleyerek her
  // ajanın ve aracın ne zaman başlayıp bittiğini deftere yazıyoruz.
  const runner = new Runner();
  runner.on("agent_start", (_ctx, agent) => {
    recorder.add({ type: "agent", name: agent.name, startedAt: new Date(), durationMs: 0 });
  });
  runner.on("agent_handoff", (_ctx, from, to) => {
    recorder.add({ type: "handoff", name: `${from.name} → ${to.name}`, startedAt: new Date(), durationMs: 0 });
  });
  runner.on("agent_tool_start", (_ctx, _agent, tool, { toolCall }) => {
    const callId = "callId" in toolCall ? toolCall.callId : (toolCall.id ?? tool.name);
    const args = ("arguments" in toolCall ? toolCall.arguments : undefined) ?? "";
    recorder.toolStart(callId, tool.name, args);
  });
  runner.on("agent_tool_end", (_ctx, _agent, tool, result, { toolCall }) => {
    const callId = "callId" in toolCall ? toolCall.callId : (toolCall.id ?? tool.name);
    recorder.toolEnd(callId, result);
  });

  try {
    const result = await runner.run(entry, toAgentInput(history), { maxTurns: 6 });
    const text = String(result.finalOutput ?? "").trim() || FRIENDLY_ERROR;
    const u = result.state.usage;
    await recorder.save({
      conversationId,
      input: lastCustomerText,
      finalOutput: text,
      lastAgent: result.lastAgent?.name,
      status: "ok",
      usage: { requests: u.requests, inputTokens: u.inputTokens, outputTokens: u.outputTokens, totalTokens: u.totalTokens },
    });
    return { text, runId: recorder.runId, ok: true };
  } catch (e) {
    console.error("[runAgent]", e);
    await recorder
      .save({
        conversationId,
        input: lastCustomerText,
        status: "error",
        error: (e as Error).message,
        usage: { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      })
      .catch((err) => console.error("[runAgent] trace save failed", err));
    return { text: FRIENDLY_ERROR, runId: recorder.runId, ok: false };
  }
}
