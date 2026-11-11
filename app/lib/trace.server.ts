/**
 * Run kaydı ("kara kutu").
 *
 * Bir müşteri mesajı = bir run. Run boyunca olan her adım (ajan başladı, model
 * çağrıldı, araç çağrıldı) bir `Span` olarak bu defterde birikir; run bitince tek
 * bir document olarak `traces` collection'ına yazılır.
 *
 * Her run kendi defterini alır (Express'teki isteğe özel `req` nesnesi gibi), bu
 * yüzden aynı anda gelen iki sohbetin adımları birbirine karışmaz.
 */
import { randomUUID } from "node:crypto";
import type { ObjectId } from "mongodb";
import { collections } from "./db.server";
import type { Span, Trace } from "./types";

export class RunRecorder {
  readonly runId = randomUUID();
  readonly startedAt = new Date();
  readonly spans: Span[] = [];
  private openTools = new Map<string, { span: Span; t0: number }>();

  add(span: Span) {
    this.spans.push(span);
  }

  toolStart(callId: string, name: string, rawArgs: string) {
    const span: Span = { type: "tool", name, input: parseJson(rawArgs), startedAt: new Date(), durationMs: 0 };
    this.spans.push(span);
    this.openTools.set(callId, { span, t0: performance.now() });
  }

  toolEnd(callId: string, result: string) {
    const open = this.openTools.get(callId);
    if (!open) return;
    open.span.output = parseJson(result);
    open.span.durationMs = Math.round(performance.now() - open.t0);
    this.openTools.delete(callId);
  }

  async save(args: Omit<Trace, "runId" | "startedAt" | "durationMs" | "spans"> & { conversationId: ObjectId }) {
    const doc: Trace = {
      ...args,
      runId: this.runId,
      startedAt: this.startedAt,
      durationMs: Date.now() - this.startedAt.getTime(),
      spans: this.spans,
    };
    await collections.traces().insertOne(doc);
    return doc;
  }
}

function parseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
