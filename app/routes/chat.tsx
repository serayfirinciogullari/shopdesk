/**
 * /chat/:conversationId: müşteri sohbet ekranı.
 *
 * loader  ≈ Express'te GET handler: sayfa açılmadan önce sunucuda çalışır, sohbeti okur.
 * action  ≈ Express'te POST handler: form gönderilince çalışır, mesajı ajana verir.
 * Action bittikten sonra React Router loader'ı kendiliğinden yeniden çalıştırır,
 * yani ekran veritabanındaki son hâli gösterir.
 */
import { useEffect, useRef } from "react";
import { data, Link, useFetcher } from "react-router";
import { ObjectId } from "mongodb";
import type { Route } from "./+types/chat";
import { collections } from "~/lib/db.server";
import { runAgent } from "~/agents/run.server";
import type { Message } from "~/lib/types";

const MAX_LEN = 1000;

function parseId(raw: string | undefined) {
  if (!raw || !ObjectId.isValid(raw)) throw data("Conversation not found", { status: 404 });
  return new ObjectId(raw);
}

export function meta({}: Route.MetaArgs) {
  return [{ title: "Chat · ShopDesk" }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const _id = parseId(params.conversationId);
  const convo = await collections.conversations().findOne({ _id });
  if (!convo) throw data("Conversation not found", { status: 404 });
  return {
    status: convo.status,
    messages: convo.messages.map((m) => ({ role: m.role, text: m.text, at: m.at.toISOString() })),
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const _id = parseId(params.conversationId);
  const form = await request.formData();
  const text = String(form.get("text") ?? "").trim();
  if (!text) return data({ error: "Please type a message." }, { status: 400 });
  if (text.length > MAX_LEN) return data({ error: `Messages can be at most ${MAX_LEN} characters.` }, { status: 400 });

  const convos = collections.conversations();
  const customerMsg: Message = { role: "customer", text, at: new Date() };
  // $push: document'ın içindeki diziye eleman ekler (SQL'de ayrı tabloya INSERT yerine).
  const convo = await convos.findOneAndUpdate(
    { _id },
    { $push: { messages: customerMsg }, $set: { updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  if (!convo) throw data("Conversation not found", { status: 404 });

  const reply = await runAgent(_id, convo.messages);

  await convos.updateOne(
    { _id },
    {
      $push: { messages: { role: "agent", text: reply.text, at: new Date(), runId: reply.runId } },
      $set: { updatedAt: new Date() },
    },
  );
  return { ok: true };
}

export default function Chat({ loaderData }: Route.ComponentProps) {
  const fetcher = useFetcher<typeof action>();
  const formRef = useRef<HTMLFormElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const sending = fetcher.state !== "idle";
  // İyimser gösterim: sunucu cevap verene kadar müşterinin mesajını hemen göster.
  const pendingText = sending ? String(fetcher.formData?.get("text") ?? "") : null;
  const error = fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;

  useEffect(() => {
    if (fetcher.state === "submitting") formRef.current?.reset();
  }, [fetcher.state]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [loaderData.messages.length, sending]);

  return (
    <main className="mx-auto flex h-dvh max-w-2xl flex-col p-4">
      <header className="flex items-center justify-between border-b border-gray-200 pb-3">
        <div>
          <Link to="/" className="text-lg font-semibold">ShopDesk</Link>
          <p className="text-sm text-gray-500">Customer support</p>
        </div>
        <Link to="/chat" reloadDocument className="text-sm text-gray-600 underline">New chat</Link>
      </header>

      <section className="flex-1 space-y-3 overflow-y-auto py-4" aria-live="polite">
        {loaderData.messages.length === 0 && !pendingText && (
          <p className="text-sm text-gray-500">
            Hi! Ask about an order, e.g. “Where is my order #1042? My email is ayse@example.com”.
          </p>
        )}
        {loaderData.messages.map((m, i) => (
          <Bubble key={i} role={m.role} text={m.text} />
        ))}
        {pendingText && <Bubble role="customer" text={pendingText} />}
        {sending && <p className="text-sm text-gray-400">Typing…</p>}
        <div ref={bottomRef} />
      </section>

      <fetcher.Form ref={formRef} method="post" className="flex gap-2 border-t border-gray-200 pt-3">
        <input
          name="text"
          autoComplete="off"
          maxLength={MAX_LEN}
          placeholder="Type your message…"
          className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-gray-400"
          disabled={sending}
          autoFocus
        />
        <button
          type="submit"
          disabled={sending}
          className="rounded-lg bg-gray-900 px-4 py-2 text-white hover:bg-gray-700 disabled:opacity-50"
        >
          Send
        </button>
      </fetcher.Form>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </main>
  );
}

function Bubble({ role, text }: { role: Message["role"]; text: string }) {
  const mine = role === "customer";
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2 ${
          mine ? "bg-gray-900 text-white" : "border border-gray-200 bg-white"
        }`}
      >
        {role === "human" && <span className="mb-1 block text-xs text-gray-500">Support team</span>}
        <Linkified text={text} />
      </div>
    </div>
  );
}

/** Ajan cevabındaki takip linklerini tıklanabilir yapar. */
function Linkified({ text }: { text: string }) {
  // Sondaki noktalama URL'ye dahil edilmez: "…/TR1042SD." → link "…/TR1042SD"
  const parts = text.split(/(https?:\/\/[^\s)]*[^\s).,!?;:])/g);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noreferrer" className="underline">
            {p}
          </a>
        ) : (
          p
        ),
      )}
    </>
  );
}
