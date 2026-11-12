/**
 * /tests: eval sonuçları ve turların geçmişi (lookfor panelindeki Optimize → Tests gibi).
 *
 * Canlı demoda eval çalıştırılmaz (model kotası). Sayfa son kaydedilmiş sonucu okur:
 *   eval/results.json  son turun senaryo bazında sonuçları (npm run eval yazar)
 *   eval/rounds.json   tur geçmişi; başarısız turlar silinmez
 * İkisi de build'e girer, yani bu sayfa veritabanına dokunmaz.
 *
 * Seçili tur URL'de değil, sayfa içinde: "Play rounds" turları sırayla gösterir.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Route } from "./+types/tests";
import { Nav } from "~/components/ui";
import { CountUp } from "~/components/CountUp";
import { EVAL_LABELS, GROUP_LABEL, type EvalGroup } from "~/lib/eval-labels";
import results from "../../eval/results.json";
import roundsFile from "../../eval/rounds.json";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Tests · ShopDesk" }];
}

interface ResultRow {
  id: number;
  pass: boolean;
  outcome: string;
  checks: { name: string; pass: boolean; detail?: string }[];
  tokens: number;
  requests: number;
  at: string;
}
interface Round {
  round: number;
  date: string;
  passed: number;
  total: number;
  model?: string;
  change: string | null;
  failures: { id: number; what: string }[];
  note?: string;
}

export async function loader() {
  const rows = Object.values(results as unknown as Record<string, ResultRow>)
    .sort((a, b) => a.id - b.id)
    .map((r) => ({
      id: r.id,
      pass: r.pass,
      outcome: r.outcome,
      checks: r.checks.map((c) => ({ name: c.name, pass: c.pass })),
      tokens: r.tokens,
      requests: r.requests,
      at: r.at,
      label: EVAL_LABELS[r.id] ?? { title: `#${r.id}`, expected: "", group: "orders" as EvalGroup },
    }));
  const rounds = roundsFile as Round[];
  const lastRunAt = rows.reduce((m, r) => (r.at > m ? r.at : m), "");
  return { rows, rounds, lastRunAt };
}

const CIRC = 2 * Math.PI * 30;

export default function Tests({ loaderData }: Route.ComponentProps) {
  const { rows, rounds, lastRunAt } = loaderData;
  const latest = rounds.at(-1);
  const [sel, setSel] = useState(latest?.round ?? 0);
  const [group, setGroup] = useState<EvalGroup | "all">("all");
  const playing = useRef<number[]>([]);
  const round = rounds.find((r) => r.round === sel) ?? latest;
  const isLatest = !round || round.round === latest?.round;

  // Seçili turda başarısız olan senaryolar; son turda results.json'daki gerçek sonuç geçerli.
  const failedIn = (r: Round | undefined) => new Map((r?.failures ?? []).map((f) => [f.id, f.what]));
  const failNow = failedIn(round);
  const passOf = (id: number, livePass: boolean) => (isLatest ? livePass && !failNow.has(id) : !failNow.has(id));
  const passed = round ? round.passed : rows.filter((r) => r.pass).length;
  const total = round ? round.total : rows.length;

  const play = () => {
    playing.current.forEach(clearTimeout);
    playing.current = rounds.map((r, i) => window.setTimeout(() => setSel(r.round), i * 1900));
  };
  useEffect(() => () => playing.current.forEach(clearTimeout), []);

  const visible = rows.filter((r) => group === "all" || r.label.group === group);

  return (
    <main className="mx-auto max-w-6xl p-4 pb-16">
      <Nav />

      <header className="mt-4 flex flex-wrap items-center gap-5 rounded-2xl border border-gray-200 bg-white p-4">
        <Ring passed={passed} total={total} />
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold">
            Round {round?.round ?? "–"} · <CountUp key={sel} to={passed} durationMs={900} />/{total} pass
          </h1>
          <p className="mt-0.5 max-w-2xl text-sm text-gray-600">
            Each scenario is checked against the trace (which tool ran, what it returned, whether an approval step exists), not against the reply text.
            {lastRunAt && <> Last run {new Date(lastRunAt).toLocaleDateString("en-GB")}. Evals don't run on the live demo; they cost model quota.</>}
          </p>
        </div>
        <button type="button" onClick={play} className="rounded-full border border-gray-300 px-4 py-1.5 text-sm font-medium hover:bg-gray-50">
          Play rounds
        </button>
      </header>

      <ol aria-label="Rounds" className="mt-4 grid gap-3 md:grid-cols-[repeat(auto-fit,minmax(220px,1fr))]">
        {rounds.map((r, i) => {
          const active = r.round === sel;
          const ok = r.passed === r.total;
          return (
            <li key={r.round} className="anim-rise" style={{ "--d": `${i * 90}ms` } as React.CSSProperties}>
              <button
                type="button"
                onClick={() => setSel(r.round)}
                aria-pressed={active}
                className={`flex h-full w-full flex-col gap-1.5 rounded-2xl border bg-white p-3 text-left text-sm transition-colors ${active ? (ok ? "border-emerald-600" : "border-amber-500") : "border-gray-200 hover:border-gray-400"}`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px] tracking-widest text-gray-500 uppercase">Round {r.round} · {new Date(r.date).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${ok ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>{r.passed}/{r.total}</span>
                </span>
                {r.change && (
                  <span className="rounded-lg bg-emerald-50 px-2 py-1 font-mono text-[11.5px] leading-snug text-emerald-800">+ {r.change}</span>
                )}
                {r.failures.length > 0 ? (
                  <span className="text-gray-700">{r.failures.map((f) => `#${f.id}`).join(", ")} failed</span>
                ) : (
                  <span className="text-gray-700">No failures.</span>
                )}
                {r.note && <span className="text-xs text-gray-500">{r.note}</span>}
              </button>
            </li>
          );
        })}
      </ol>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Scenarios{!isLatest && <span className="ml-2 text-sm font-normal text-gray-500">as of round {round?.round}</span>}</h2>
        <div className="flex flex-wrap gap-1 text-xs">
          {(["all", "orders", "rules", "human", "safety"] as const).map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => setGroup(g)}
              aria-pressed={group === g}
              className={`rounded-full px-3 py-1 ${group === g ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-100"}`}
            >
              {g === "all" ? "All" : GROUP_LABEL[g]}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-2 overflow-x-auto rounded-2xl border border-gray-200 bg-white">
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead>
            <tr className="bg-gray-50 text-left font-mono text-[10.5px] tracking-widest text-gray-500 uppercase">
              <th className="px-3 py-2 font-normal">#</th>
              <th className="px-3 py-2 font-normal">Scenario</th>
              <th className="px-3 py-2 font-normal">Expected (checked in the trace)</th>
              <th className="px-3 py-2 font-normal">Result</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const ok = passOf(r.id, r.pass);
              // Bu senaryonun başka turlardaki başarısızlıkları: saklanmaz, satırda kalır.
              const history = rounds.filter((x) => x.round !== round?.round && failedIn(x).has(r.id)).map((x) => ({ round: x.round, what: failedIn(x).get(r.id)! }));
              return (
                <tr key={r.id} className="border-t border-gray-100 align-top">
                  <td className="px-3 py-2.5 font-mono text-xs text-gray-500 tabular-nums">{r.id}</td>
                  <td className="px-3 py-2.5">
                    <p className="font-medium">{r.label.title}</p>
                    <p className="text-xs text-gray-500">{GROUP_LABEL[r.label.group]}</p>
                    {!ok && failNow.get(r.id) && <p className="mt-1 text-xs text-red-700">{failNow.get(r.id)}</p>}
                    {history.map((h) => (
                      <p key={h.round} className="mt-1 text-xs text-gray-500">
                        Round {h.round}: failed. {h.what} {h.round < (round?.round ?? 0) && "Fixed since."}
                      </p>
                    ))}
                  </td>
                  <td className="px-3 py-2.5">
                    <p className="text-gray-700">{r.label.expected}</p>
                    {isLatest && (
                      <p className="mt-1.5 flex flex-wrap gap-1">
                        {r.checks.map((c, i) => (
                          <span key={i} className={`rounded px-1.5 py-0.5 font-mono text-[10.5px] ${c.pass ? "bg-gray-100 text-gray-600" : "bg-red-50 text-red-700"}`}>{c.name}</span>
                        ))}
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {/* key: tur değişince rozet yeniden "pop" eder. */}
                    <span key={`${sel}-${ok}`} className={`anim-pop inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
                      {ok ? "✓ PASS" : "✕ FAIL"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {latest?.model && <p className="mt-3 text-xs text-gray-500">Model chain in round {latest.round}: {latest.model}</p>}
    </main>
  );
}

/** Halka: geçen/toplam. Tur değişince yeni orana kayar; renk tam geçince yeşil, değilse sarı. */
function Ring({ passed, total }: { passed: number; total: number }) {
  const target = CIRC * (1 - passed / Math.max(total, 1));
  const [offset, setOffset] = useState(target);
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // İlk açılışta boştan dolsun (sunucu son hâli çizdi; boyamadan önce boşa çekiyoruz).
      first.current = false;
      setOffset(CIRC);
      const t = window.setTimeout(() => setOffset(target), 60);
      return () => clearTimeout(t);
    }
    first.current = false;
    setOffset(target);
  }, [target]);
  const ok = passed === total;
  return (
    <svg viewBox="0 0 72 72" className="h-[72px] w-[72px] shrink-0" aria-hidden="true">
      <circle cx="36" cy="36" r="30" fill="none" className="stroke-gray-100" strokeWidth="7" />
      <circle
        cx="36" cy="36" r="30" fill="none" strokeWidth="7" strokeLinecap="round" transform="rotate(-90 36 36)"
        strokeDasharray={CIRC} strokeDashoffset={offset}
        className={`${ok ? "stroke-emerald-500" : "stroke-amber-500"} transition-[stroke-dashoffset,stroke] duration-1000 ease-out motion-reduce:transition-none`}
      />
      <text x="36" y="41" textAnchor="middle" className="fill-gray-900 text-[15px] font-semibold tabular-nums">{passed}/{total}</text>
    </svg>
  );
}
