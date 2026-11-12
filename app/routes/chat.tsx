/**
 * /chat/:conversationId: müşteri sohbet ekranı.
 *
 * loader  ≈ Express'te GET handler: sayfa açılmadan önce sunucuda çalışır, sohbeti okur.
 * action  ≈ Express'te POST handler: form gönderilince çalışır, mesajı ajana verir.
 * Action bittikten sonra React Router loader'ı kendiliğinden yeniden çalıştırır,
 * yani ekran veritabanındaki son hâli gösterir.
 */
import { useEffect, useRef, useState } from "react";
import { data, Link, useFetcher, useRevalidator, useSearchParams } from "react-router";
import { ObjectId } from "mongodb";
import type { Route } from "./+types/chat";
import { collections } from "~/lib/db.server";
import { sendCustomerMessage } from "~/lib/chat.server";
import { checkRateLimit } from "~/lib/ratelimit.server";
import { findScenario } from "~/lib/demo-scenarios";
import type { Message } from "~/lib/types";
import { summarizeRun } from "~/lib/trace-view";
import { StepRail } from "~/components/StepRail";

const MAX_LEN = 1000;
/** Polling: bekleyen bir ticket varken kaç ms'de bir "yeni mesaj var mı?" diye sorulur. */
const POLL_MS = 4000;
/** Unutulmuş bir sekme sonsuza kadar sormasın. */
const POLL_MAX_MS = 15 * 60_000;

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
  // Açık bir ticket varsa (onay bekleyen iade ya da insana devir) cevap Inbox'tan gelecek:
  // sayfa bu durumda kendini yeniler (polling).
  const openTickets = await collections.tickets().countDocuments({ conversationId: _id, status: "open" });

  // "What the agent did" paneli: son ajan cevabını üreten run'ın adımları.
  // Trace'te ham girdi/çıktı da var; tarayıcıya sadece özet gider (summarizeRun).
  const lastRunId = [...convo.messages].reverse().find((m) => m.runId)?.runId;
  const lastTrace = lastRunId ? await collections.traces().findOne({ runId: lastRunId }) : null;

  return {
    status: convo.status,
    waitingForHuman: openTickets > 0,
    lastRun: lastTrace ? summarizeRun(lastTrace) : null,
    messages: convo.messages.map((m) => ({ role: m.role, text: m.text, at: m.at.toISOString(), runId: m.runId ?? null })),
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const _id = parseId(params.conversationId);
  const form = await request.formData();
  const text = String(form.get("text") ?? "").trim();
  if (!text) return data({ error: "Please type a message." }, { status: 400 });
  if (text.length > MAX_LEN) return data({ error: `Messages can be at most ${MAX_LEN} characters.` }, { status: 400 });

  // Canlı demo koruması: model çağrılmadan önce IP ve günlük limit kontrolü.
  const limit = await checkRateLimit(request);
  if (!limit.ok) return data({ error: limit.message }, { status: 429 });

  // İş mantığı chat.server.ts'te; eval de aynı fonksiyonu kullanır.
  const result = await sendCustomerMessage(_id, text);
  if (result.status === "not_found") throw data("Conversation not found", { status: 404 });
  return { ok: true };
}

export default function Chat({ loaderData }: Route.ComponentProps) {
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const bottomRef = useRef<HTMLDivElement>(null);
  const [searchParams] = useSearchParams();

  // Ana sayfadaki "Try these" butonundan gelindiyse mesaj hazır doldurulur (gönderen ziyaretçi).
  const scenario = loaderData.messages.length === 0 ? findScenario(searchParams.get("try")) : undefined;
  const [draft, setDraft] = useState(scenario?.message ?? "");
  const lastSent = useRef("");

  const sending = fetcher.state !== "idle";
  // İyimser gösterim: sunucu cevap verene kadar müşterinin mesajını hemen göster.
  const pendingText = sending ? String(fetcher.formData?.get("text") ?? "") : null;
  const error = fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;

  useEffect(() => {
    if (fetcher.state === "submitting") {
      lastSent.current = String(fetcher.formData?.get("text") ?? "");
      setDraft("");
    }
    // Mesaj reddedildiyse (ör. rate limit) yazılanı kaybettirme.
    if (fetcher.state === "idle" && error && lastSent.current) {
      setDraft(lastSent.current);
      lastSent.current = "";
    }
  }, [fetcher.state, error]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [loaderData.messages.length, sending]);

  // Polling: Inbox'ta bir temsilci karar verene kadar birkaç saniyede bir loader'ı
  // yeniden çalıştır (sayfa yenilenmeden yeni mesaj görünür). Sekme arka plandaysa sorma.
  const waiting = loaderData.waitingForHuman && !sending;
  useEffect(() => {
    if (!waiting) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > POLL_MAX_MS) return clearInterval(timer);
      if (document.visibilityState === "visible" && revalidator.state === "idle") revalidator.revalidate();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, revalidator]);

  return (
    // Geniş ekranda iki sütun: solda sohbet, sağda "What the agent did" paneli.
    // Dar ekranda panel gizli; her ajan mesajındaki "Trace" linki aynı bilgiye götürür.
    <main className="mx-auto grid h-dvh max-w-6xl grid-rows-[minmax(0,1fr)] gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_340px]">
     <div className="flex min-h-0 flex-col">
      <header className="flex items-center justify-between border-b border-gray-200 pb-3">
        <div>
          <Link to="/" className="text-lg font-semibold">ShopDesk</Link>
          <p className="text-sm text-gray-500">Customer support</p>
        </div>
        <div className="flex gap-4 text-sm text-gray-600">
          <Link to="/inbox" className="underline">Inbox</Link>
          <Link to="/chat" reloadDocument className="underline">New chat</Link>
        </div>
      </header>

      <section className="flex-1 space-y-3 overflow-y-auto py-4" aria-live="polite">
        {loaderData.messages.length === 0 && !pendingText && (
          <p className="text-sm text-gray-500">
            Hi! Ask about an order, e.g. “Where is my order #1042? My email is ayse@example.com”.
          </p>
        )}
        {loaderData.messages.map((m, i) => (
          <Bubble key={i} role={m.role} text={m.text} runId={m.runId} />
        ))}
        {pendingText && <Bubble role="customer" text={pendingText} />}
        {sending && loaderData.status !== "escalated" && (
          <div className="anim-rise inline-flex rounded-2xl border border-gray-200 bg-white px-4 py-3 text-gray-400" aria-label="The agent is typing">
            <span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>
          </div>
        )}
        {loaderData.status === "escalated" && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            You've been transferred to a support agent. A team member will reply here.
          </p>
        )}
        {loaderData.waitingForHuman && loaderData.status !== "escalated" && (
          <p className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">
            Waiting for a team member's approval. This page updates by itself.{" "}
            <Link to="/inbox" target="_blank" className="underline">Open the Inbox</Link> to decide.
          </p>
        )}
        <div ref={bottomRef} />
      </section>

      {scenario && draft === scenario.message && (
        <p className="pb-2 text-xs text-gray-500">Demo message filled in. Press Send (you can edit it first).</p>
      )}
      <fetcher.Form method="post" className="flex gap-2 border-t border-gray-200 pt-3">
        <input
          name="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
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
     </div>
      <div className="hidden min-h-0 lg:flex lg:flex-col [&>aside]:flex-1">
        <StepRail run={loaderData.lastRun} working={sending && loaderData.status !== "escalated"} />
      </div>
    </main>
  );
}

function Bubble({ role, text, runId }: { role: Message["role"]; text: string; runId?: string | null }) {
  const mine = role === "customer";
  return (
    <div className={`anim-rise flex flex-col gap-1 ${mine ? "items-end" : "items-start"}`}>
      <div
        className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2 ${
          mine ? "rounded-br-md bg-gray-900 text-white" : "rounded-bl-md border border-gray-200 bg-white"
        }`}
      >
        {role === "human" && <span className="mb-1 block text-xs text-gray-500">Support team</span>}
        <Linkified text={text} />
      </div>
      {runId && (
        // lookfor Inbox'taki gibi: her AI mesajında bir rozet, tıklayınca o cevabın trace'i.
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span className="rounded-full bg-violet-50 px-2 py-0.5 font-medium text-violet-700">✦ AI generated</span>
          <Link to={`/traces/${runId}`} className="font-medium text-violet-700 hover:underline">
            Trace ›
          </Link>
        </div>
      )}
    </div>
  );
}

/** Ajan cevabındaki takip linklerini tıklanabilir yapar. */
function Linkified({ text }: { text: string }) {
  // Sondaki noktalama URL'ye dahil edilmez: "…/TR1042SD." → link "…/TR1042SD"
  // Model bazen linki <…> içine alıyor; açılı parantezler de URL'ye dahil edilmez.
  const parts = text.split(/(https?:\/\/[^\s)<>]*[^\s).,!?;:<>])/g);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noreferrer" className="underline">
            {p}
          </a>
        ) : (
          // Model bazen Markdown kalın yazıyor ("**3649 TRY**"): yıldızları göstermek yerine kalın yaz.
          p.split(/\*\*([^*\n]+)\*\*/g).map((q, j) => (j % 2 === 1 ? <strong key={`${i}-${j}`}>{q}</strong> : q))
        ),
      )}
    </>
  );
}
