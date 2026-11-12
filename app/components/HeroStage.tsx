/**
 * Ana sayfadaki canlı sahne: gerçek bir prompt injection run'ını tekrar oynatır.
 * Mesaj yazılır → gönderilir → ajan adımları belirir → kuralın reddi "damga" gibi düşer
 * → ajanın cevabı yazılır. Hepsi o run'ın trace'inden (demo.server.ts › findStageRun);
 * model çağrılmaz.
 *
 * Sunucu son hâli çizer (JS yoksa da içerik görünür). Tarayıcıda boyamadan önce
 * (useLayoutEffect) başa sarılır ve oynatılır; hareket azaltma açıksa son hâlde kalır.
 */
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { fmtMs, type RunVerdict } from "~/lib/trace-view";

export interface StageRun {
  runId: string;
  message: string;
  reply: string;
  verdict: RunVerdict;
  steps: { kind: string; label: string; offsetMs: number }[];
  durationMs: number;
}

interface Frame {
  typed: number; // composer'da yazılmış karakter
  sent: boolean;
  steps: number; // görünen adım sayısı
  verdict: boolean;
  reply: number; // cevaptan yazılmış karakter
}

const START_MS = 1100;
const TYPE_MS = 22; // 2 karakterde bir
const STEP_MS = 480;

export function HeroStage({ run }: { run: StageRun }) {
  const final: Frame = { typed: 0, sent: true, steps: run.steps.length, verdict: true, reply: run.reply.length };
  const [f, setF] = useState<Frame>(final);
  const timers = useRef<number[]>([]);

  const play = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return setF(final);
    const at = (ms: number, fn: () => void) => timers.current.push(window.setTimeout(fn, ms));

    setF({ typed: 0, sent: false, steps: 0, verdict: false, reply: 0 });
    let t = START_MS;
    for (let n = 2; n < run.message.length + 2; n += 2) {
      const v = Math.min(n, run.message.length);
      at((t += TYPE_MS), () => setF((p) => ({ ...p, typed: v })));
    }
    at((t += 260), () => setF((p) => ({ ...p, typed: 0, sent: true })));
    for (let i = 1; i <= run.steps.length; i++) at((t += STEP_MS), () => setF((p) => ({ ...p, steps: i })));
    at((t += 520), () => setF((p) => ({ ...p, verdict: true })));
    t += 600;
    for (let n = 3; n < run.reply.length + 3; n += 3) {
      const v = Math.min(n, run.reply.length);
      at((t += 16), () => setF((p) => ({ ...p, reply: v })));
    }
    // final içeren kapanış yok: `final` her render'da yeni nesne, bağımlılığa koymuyoruz.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  useLayoutEffect(() => {
    play();
    return () => timers.current.forEach(clearTimeout);
  }, [play]);

  const typing = !f.sent && f.typed > 0;
  const replyStarted = f.reply > 0;

  return (
    <figure className="anim-rise relative m-0 rounded-[22px] border border-gray-200 bg-gray-100 p-2.5" style={{ "--d": "400ms" } as React.CSSProperties}>
      <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
        <div className="flex items-center gap-2 border-b border-gray-200 px-3 py-2 text-xs">
          <span className="grid h-6 w-6 place-items-center rounded-full bg-gray-900 text-[10px] font-semibold text-white">SD</span>
          <span className="font-medium">ShopDesk support</span>
          <span className="ml-auto flex items-center gap-1.5 font-mono text-[10.5px] tracking-widest text-gray-500">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            REPLAY OF A REAL RUN
          </span>
        </div>

        <div className="flex min-h-[330px] flex-col gap-2 p-3 text-[13px]" aria-live="off">
          {f.sent && <div className="anim-rise max-w-[88%] self-end rounded-2xl rounded-br-md bg-gray-900 px-3 py-2 text-white">{run.message}</div>}
          {run.steps.slice(0, f.steps).map((s, i) => (
            <div key={i} className="anim-rise flex min-w-0 items-center gap-2 rounded-xl border border-gray-200 px-2.5 py-1.5 text-xs">
              <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${s.kind === "tool" ? "bg-emerald-50 text-emerald-700" : "bg-violet-50 text-violet-700"}`}>
                {s.kind === "tool" ? "Tool" : s.kind === "handoff" ? "Handoff" : "Agent"}
              </span>
              <span className={`truncate ${s.kind === "tool" ? "font-mono" : ""}`}>{s.label.replace(/^Agent · |^Handoff /, "")}</span>
              <span className="ml-auto shrink-0 font-mono text-[11px] text-gray-400">+{fmtMs(s.offsetMs)}</span>
            </div>
          ))}
          {f.verdict && (
            <div className="anim-stamp rounded-xl border-[1.5px] border-red-600 bg-red-50 px-3 py-2 text-red-900">
              <p className="font-mono text-[10.5px] font-semibold tracking-widest text-red-700">REFUSED BY CODE</p>
              <p className="mt-0.5">{run.verdict.title.replace(/^Refused by rule: /, "")}</p>
            </div>
          )}
          {f.verdict && (replyStarted || f.reply === run.reply.length) && (
            <div className="anim-rise max-w-[92%] self-start whitespace-pre-wrap rounded-2xl rounded-bl-md border border-gray-200 bg-white px-3 py-2">
              {run.reply.slice(0, f.reply)}
              {f.reply < run.reply.length && <span className="caret" aria-hidden="true" />}
              <span className="text-transparent" aria-hidden="true">{run.reply.slice(f.reply)}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-gray-200 px-3 py-2.5">
          <div className={`min-w-0 flex-1 truncate rounded-full border border-gray-300 px-3 py-1.5 text-xs ${typing ? "text-gray-800" : "text-gray-400"}`}>
            {typing ? (
              <>
                {run.message.slice(0, f.typed)}
                <span className="caret" aria-hidden="true" />
              </>
            ) : (
              "Type a message…"
            )}
          </div>
          <span aria-hidden="true" className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-gray-900 text-white">
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-none stroke-current stroke-[2.4] [stroke-linecap:round] [stroke-linejoin:round]"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </span>
        </div>
      </div>
      <figcaption className="mt-2 flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-gray-500">
        <span>Same message, same tools, same rule. {fmtMs(run.durationMs)} in real time.</span>
        <span className="flex gap-3">
          <button type="button" onClick={play} className="font-medium text-gray-700 hover:underline">Replay</button>
          <Link to={`/traces/${run.runId}`} className="font-medium text-violet-700 hover:underline">This run's trace ›</Link>
        </span>
      </figcaption>
    </figure>
  );
}
