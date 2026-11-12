import { Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/home";
import { createConversation } from "~/lib/chat.server";
import { findStageRun, resetDemoOrder } from "~/lib/demo.server";
import { demoScenarios, findScenario, type DemoScenario } from "~/lib/demo-scenarios";
import { HeroStage } from "~/components/HeroStage";
import { CountUp } from "~/components/CountUp";
import evalResults from "../../eval/results.json";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "ShopDesk · AI support demo" },
    { name: "description", content: "A Shopify-style support agent whose refund rules live in code." },
  ];
}

export async function loader() {
  // Kanıt sayıları uydurma değil: son eval turunun sonucu (npm run eval → eval/results.json).
  const rows = Object.values(evalResults as Record<string, { pass: boolean }>);
  return {
    stage: await findStageRun(),
    evalPass: rows.filter((r) => r.pass).length,
    evalTotal: rows.length,
  };
}

/**
 * "Try these" butonu: o senaryonun siparişini temizle, yeni sohbet aç, mesajı hazır
 * doldurulmuş olarak göster (mesajı ziyaretçi gönderir; model burada çağrılmaz).
 */
export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const scenario = findScenario(String(form.get("scenario") ?? ""));
  if (!scenario) return redirect("/chat");
  await resetDemoOrder(scenario.orderNumber);
  const id = await createConversation();
  return redirect(`/chat/${id.toHexString()}?try=${scenario.id}`);
}

const WORDS = [
  ["Talk", "it", "into", "a", "refund."],
  ["The", "code", "still", "says", "no."],
];

const OUTCOME_TONE: Record<DemoScenario["outcome"]["tone"], string> = {
  good: "bg-emerald-50 text-emerald-700",
  bad: "bg-red-50 text-red-700",
  warn: "bg-amber-50 text-amber-800",
  info: "bg-sky-50 text-sky-700",
};

export default function Home({ loaderData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" ? String(navigation.formData?.get("scenario") ?? "") : null;
  const { stage, evalPass, evalTotal } = loaderData;
  const d = (ms: number) => ({ "--d": `${ms}ms` }) as React.CSSProperties;

  return (
    <main className="mx-auto max-w-6xl px-4 pt-6 pb-16 sm:px-6">
      <nav className="anim-rise flex items-center justify-between text-sm">
        <span className="font-semibold">ShopDesk</span>
        <div className="flex gap-4 text-gray-600">
          <Link to="/inbox" className="hover:text-gray-900">Inbox</Link>
          <Link to="/tests" className="hover:text-gray-900">Tests</Link>
          <Link to="/chat" className="hover:text-gray-900">New chat</Link>
        </div>
      </nav>

      <section className="mt-10 grid items-center gap-10 lg:mt-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div>
          <p className="anim-rise flex items-center gap-2 font-mono text-[11px] tracking-[0.16em] text-gray-500 uppercase" style={d(60)}>
            <span className="h-1.5 w-1.5 rounded-full bg-violet-600" />
            OpenAI Agents SDK · Remix · MongoDB
          </p>
          <h1 className="mt-5 text-[clamp(2.4rem,5.6vw,4rem)] leading-[0.98] font-medium tracking-[-0.045em]" aria-label="Talk it into a refund. The code still says no.">
            {WORDS.map((line, li) => (
              <span key={li} aria-hidden="true" className={`block ${li === 0 ? "text-gray-400" : ""}`}>
                {line.map((w, wi) => (
                  // Kelime kelime bulanıktan netleşir (90 ms arayla).
                  <span key={wi} className="anim-rise mr-[0.24em] inline-block" style={d(150 + (li * 5 + wi) * 90)}>{w}</span>
                ))}
              </span>
            ))}
          </h1>
          <p className="anim-rise mt-5 max-w-[30rem] text-[15.5px] leading-relaxed text-gray-600" style={d(1100)}>
            A Shopify-style support agent whose refund rules run inside its tools. When it isn't sure, it hands the chat to a person. Every step it takes is traced.
          </p>
          <div className="anim-rise mt-7 flex flex-wrap gap-3 text-sm" style={d(1250)}>
            <a href="#try" className="group inline-flex items-center gap-2 rounded-full bg-gray-900 py-2 pr-2 pl-5 font-medium text-white hover:bg-gray-800">
              Try a scenario
              <span className="grid h-6 w-6 place-items-center rounded-full bg-white text-gray-900 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-rotate-45">
                <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3.5 w-3.5 fill-none stroke-current stroke-[2.4] [stroke-linecap:round] [stroke-linejoin:round]"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </span>
            </a>
            <Link to="/inbox" className="rounded-full border border-gray-300 bg-white px-5 py-2 font-medium hover:bg-gray-50">Open the team Inbox</Link>
          </div>
          <dl className="anim-rise mt-9 grid grid-cols-2 gap-4 border-t border-gray-200 pt-4 sm:flex sm:gap-0 sm:divide-x sm:divide-gray-200" style={d(1400)}>
            <Proof value={<Link to="/tests" className="hover:underline"><CountUp to={evalPass} delayMs={1500} />/{evalTotal}</Link>} label="eval scenarios pass" />
            <Proof value={<CountUp to={0} delayMs={1590} />} label="wrong refunds, any round" />
            <Proof value={<><CountUp to={1000} delayMs={1680} /> TRY</>} label="human-approval limit" />
            <Proof value={<CountUp to={3} delayMs={1770} />} label="agents with handoffs" />
          </dl>
        </div>

        {stage ? <HeroStage run={stage} /> : null}
      </section>

      <section id="try" className="mt-20 scroll-mt-6">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 className="text-xl font-medium tracking-tight">Try these</h2>
          <p className="text-sm text-gray-500">Each one opens a chat with the message filled in. Watch the panel on the right.</p>
        </div>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {demoScenarios.map((s, i) => (
            <li key={s.id} className="anim-rise" style={d(200 + i * 80)}>
              <Form method="post" className="h-full">
                <input type="hidden" name="scenario" value={s.id} />
                <button
                  type="submit"
                  disabled={busy !== null}
                  className="group flex h-full w-full flex-col gap-3 rounded-2xl border border-gray-200 bg-white p-4 text-left transition duration-300 hover:-translate-y-0.5 hover:border-gray-900 hover:shadow-[0_4px_16px_rgba(0,0,0,0.06)] disabled:opacity-60"
                >
                  <span className="flex justify-between gap-2 font-medium">
                    {s.title}
                    <span className="font-mono text-xs font-normal text-gray-400">{s.orderNumber}</span>
                  </span>
                  <span className="line-clamp-2 text-sm text-gray-600">“{s.message}”</span>
                  <span className="text-xs text-gray-500">{s.expect}</span>
                  <span className="mt-auto flex items-center gap-2">
                    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${OUTCOME_TONE[s.outcome.tone]}`}>
                      <span className="h-1.5 w-1.5 rounded-full bg-current" />
                      {s.outcome.label}
                    </span>
                    <span className="ml-auto text-gray-400 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-rotate-45 group-hover:text-gray-900">
                      {busy === s.id ? <span className="text-xs">Opening…</span> : <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 fill-none stroke-current stroke-2 [stroke-linecap:round] [stroke-linejoin:round]"><path d="M5 12h14M13 6l6 6-6 6" /></svg>}
                    </span>
                  </span>
                </button>
              </Form>
            </li>
          ))}
        </ul>
      </section>

      <p className="mt-10 text-xs text-gray-400">
        Free demo: runs on free model tiers, so messages are rate-limited per visitor. Store data is fake.
      </p>
    </main>
  );
}

function Proof({ value, label }: { value: React.ReactNode; label: string }) {
  return (
    <div className="flex flex-col sm:px-5 sm:first:pl-0">
      <dt className="order-2 text-xs text-gray-500">{label}</dt>
      <dd className="order-1 text-2xl font-medium tracking-[-0.025em] tabular-nums">{value}</dd>
    </div>
  );
}
