/**
 * /inbox: temsilci ekranı. Ajanın insana bıraktığı işler (escalation ve
 * onay bekleyen iadeler) burada; temsilci Onayla / Reddet ile karar verir.
 *
 * loader ≈ GET /inbox, action ≈ POST /inbox (Express'teki iki handler).
 * Her ticket kendi `useFetcher`'ıyla gönderilir; sayfa yenilenmeden o kart güncellenir.
 */
import { data, Link, useFetcher } from "react-router";
import type { Route } from "./+types/inbox";
import { collections } from "~/lib/db.server";
import { decideTicket, type Decision } from "~/lib/inbox.server";
import { checkRateLimit } from "~/lib/ratelimit.server";
import { Nav, TicketPill } from "~/components/ui";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Inbox · ShopDesk" }];
}

export async function loader() {
  const tickets = collections.tickets();
  const [open, recent] = await Promise.all([
    tickets.find({ status: "open" }).sort({ createdAt: -1 }).limit(50).toArray(),
    tickets.find({ status: { $ne: "open" } }).sort({ decidedAt: -1 }).limit(10).toArray(),
  ]);
  const all = [...open, ...recent];

  // İlgili iade kayıtlarını tek sorguda çek (SQL'de JOIN; Mongo'da `$in` ile ikinci okuma).
  const returnIds = all.flatMap((t) => (t.returnId ? [t.returnId] : []));
  const returns = returnIds.length ? await collections.returns().find({ _id: { $in: returnIds } }).toArray() : [];
  const byId = new Map(returns.map((r) => [r._id.toHexString(), r]));

  const toUI = (t: (typeof all)[number]) => {
    const r = t.returnId ? byId.get(t.returnId.toHexString()) : undefined;
    return {
      id: t._id.toHexString(),
      kind: t.kind,
      status: t.status,
      reason: t.reason,
      summary: t.summary,
      suggestedAction: t.suggestedAction ?? (t.kind === "escalation" ? "Take over the conversation and reply to the customer." : null),
      createdAt: t.createdAt.toISOString(),
      decidedAt: t.decidedAt?.toISOString() ?? null,
      conversationId: t.conversationId.toHexString(),
      runId: t.runId,
      resolution: t.resolution ?? null,
      resolutionRunId: t.resolutionRunId ?? null,
      processing: !!t.processingAt,
      ret: r
        ? { orderNumber: r.orderNumber, amount: r.amount, status: r.status, items: r.items.map((i) => `${i.qty} × ${i.name} (${i.price} TRY)`) }
        : null,
    };
  };
  return { open: open.map(toUI), recent: recent.map(toUI) };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const id = String(form.get("ticketId") ?? "");
  const decision = String(form.get("decision") ?? "") as Decision;
  if (decision !== "approve" && decision !== "reject") return data({ ok: false, message: "Unknown decision." }, { status: 400 });
  // Onay, durdurulmuş run'ı sürdürür (bir model çağrısı); chat ile aynı limite sayılır.
  const limit = await checkRateLimit(request);
  if (!limit.ok) return data({ ok: false, message: limit.message }, { status: 429 });
  const result = await decideTicket(id, decision);
  return data(result, { status: result.ok ? 200 : 409 });
}

type UITicket = Route.ComponentProps["loaderData"]["open"][number];

export default function Inbox({ loaderData }: Route.ComponentProps) {
  return (
    <main className="mx-auto max-w-3xl p-4 pb-16">
      <Nav />
      <h1 className="mt-4 text-xl font-semibold">Inbox</h1>
      <p className="text-sm text-gray-500">Conversations the agent handed to a human, and refunds waiting for approval.</p>

      <section className="mt-4 space-y-3">
        {loaderData.open.length === 0 && (
          <p className="rounded-xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500">Nothing waiting. 🎉</p>
        )}
        {loaderData.open.map((t) => (
          <TicketCard key={t.id} t={t} />
        ))}
      </section>

      {loaderData.recent.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm font-semibold text-gray-700">Recently decided</h2>
          <div className="mt-2 space-y-2">
            {loaderData.recent.map((t) => (
              <TicketCard key={t.id} t={t} />
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

function TicketCard({ t }: { t: UITicket }) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const pendingDecision = busy ? String(fetcher.formData?.get("decision") ?? "") : null;
  const isReturn = t.kind === "return_approval";
  const isOpen = t.status === "open";

  return (
    <article className={`rounded-xl border bg-white p-4 ${isOpen ? "border-gray-200" : "border-gray-100 opacity-80"}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${isReturn ? "bg-amber-50 text-amber-800" : "bg-rose-50 text-rose-700"}`}>
          {isReturn ? "Refund approval" : "Escalation"}
        </span>
        <TicketPill status={t.status} />
        <span className="ml-auto text-xs text-gray-400">{new Date(t.createdAt).toLocaleString("en-GB")}</span>
      </div>

      <p className="mt-2 font-medium">{t.summary}</p>
      {t.ret && (
        <div className="mt-2 rounded-lg bg-gray-50 p-2 text-sm">
          <div className="flex flex-wrap justify-between gap-2">
            <span>{t.ret.orderNumber}</span>
            <span className="font-semibold">{t.ret.amount.toLocaleString("tr-TR")} TRY</span>
          </div>
          <ul className="mt-1 text-gray-600">
            {t.ret.items.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-gray-500">Return record: {t.ret.status}</p>
        </div>
      )}
      <dl className="mt-2 space-y-1 text-sm">
        <div>
          <dt className="inline text-gray-500">Why a human: </dt>
          <dd className="inline">{t.reason}</dd>
        </div>
        {t.suggestedAction && (
          <div>
            <dt className="inline text-gray-500">Suggested: </dt>
            <dd className="inline">{t.suggestedAction}</dd>
          </div>
        )}
      </dl>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <Link to={`/chat/${t.conversationId}`} className="text-gray-600 underline">Conversation</Link>
        <Link to={`/traces/${t.runId}`} className="text-gray-600 underline">Trace</Link>
        {t.resolutionRunId && (
          <Link to={`/traces/${t.resolutionRunId}`} className="text-gray-600 underline">Approval run</Link>
        )}
        {t.resolution && !isOpen && (
          <span className="text-xs text-gray-500">
            {t.resolution === "resumed_run" ? "agent resumed the paused run" : t.resolution === "direct_update" ? "applied directly by code" : "closed"}
          </span>
        )}

        {isOpen && (
          <fetcher.Form method="post" className="ml-auto flex gap-2">
            <input type="hidden" name="ticketId" value={t.id} />
            <button
              name="decision"
              value="reject"
              disabled={busy}
              className="rounded-lg border border-gray-300 px-3 py-1.5 hover:bg-gray-50 disabled:opacity-50"
            >
              {pendingDecision === "reject" ? "Rejecting…" : isReturn ? "Reject" : "Dismiss"}
            </button>
            <button
              name="decision"
              value="approve"
              disabled={busy}
              className="rounded-lg bg-gray-900 px-3 py-1.5 text-white hover:bg-gray-700 disabled:opacity-50"
            >
              {pendingDecision === "approve" ? (isReturn ? "Approving… (agent is resuming)" : "Saving…") : isReturn ? "Approve refund" : "Mark handled"}
            </button>
          </fetcher.Form>
        )}
      </div>
      {fetcher.data && (
        <p className={`mt-2 text-sm ${fetcher.data.ok ? "text-emerald-700" : "text-red-600"}`}>{fetcher.data.message}</p>
      )}
    </article>
  );
}
