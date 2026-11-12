/**
 * "What the agent did": sohbetin yanında, son run'ın adımları.
 *
 * Neden: ziyaretçi sohbetten çıkmadan kuralın kodda uygulandığını görsün
 * (ör. checkReturnEligibility → "Field jacket: not eligible: Final sale item").
 *
 * Adımlar sunucudan tek seferde gelir (streaming yok); sırayla belirmeleri sadece
 * CSS animasyonu (`--d` gecikmesi). Liste `runId` ile key'lendiği için polling ile
 * loader yeniden çalışınca animasyon tekrar oynamaz, sadece yeni run'da oynar.
 */
import { Link } from "react-router";
import { fmtMs, type RunStep, type RunSummary } from "~/lib/trace-view";

const STEP_GAP_MS = 380;

const DOT: Record<RunStep["kind"], { bg: string; icon: "dot" | "arrow" | "fn" | "pause" | "check" | "x" }> = {
  customer: { bg: "bg-gray-900", icon: "dot" },
  agent: { bg: "bg-violet-600", icon: "dot" },
  handoff: { bg: "bg-violet-400", icon: "arrow" },
  tool: { bg: "bg-emerald-600", icon: "fn" },
  approval: { bg: "bg-amber-500", icon: "pause" },
  reply: { bg: "bg-gray-900", icon: "check" },
  error: { bg: "bg-red-600", icon: "x" },
};

const TONE = {
  good: "bg-emerald-50 text-emerald-800",
  bad: "bg-red-50 text-red-800",
  warn: "bg-amber-50 text-amber-900",
};

export function StepRail({ run, working }: { run: RunSummary | null; working: boolean }) {
  return (
    <aside aria-label="What the agent did" className="flex min-h-0 flex-col rounded-2xl border border-gray-200 bg-white">
      <div className="border-b border-gray-200 px-4 py-3">
        <h2 className="text-sm font-semibold">What the agent did</h2>
        <p className="text-xs text-gray-500">Read from this run's trace. A real customer wouldn't see this panel.</p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {working ? (
          <p className="flex items-center gap-2 text-sm text-gray-500">
            <span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>
            The agent is working…
          </p>
        ) : run ? (
          <ol key={run.runId} className="flex flex-col">
            {run.steps.map((s, i) => (
              <Step key={i} step={s} delayMs={i * STEP_GAP_MS} last={i === run.steps.length - 1} />
            ))}
          </ol>
        ) : (
          <p className="text-sm text-gray-500">Send a message. Each step the agent takes will show up here.</p>
        )}
      </div>

      {run && !working && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-200 px-4 py-3 text-xs text-gray-500">
          <span className="tabular-nums">
            {fmtMs(run.durationMs)} · {run.modelCalls} model calls · {run.totalTokens.toLocaleString("en-US")} tokens
            {run.fellBack && <span className="ml-1 rounded bg-amber-100 px-1 text-amber-800">fallback</span>}
          </span>
          <Link to={`/traces/${run.runId}`} className="rounded-full border border-gray-300 px-3 py-1 text-gray-700 hover:bg-gray-50">
            Full trace ›
          </Link>
        </div>
      )}
    </aside>
  );
}

function Step({ step, delayMs, last }: { step: RunStep; delayMs: number; last: boolean }) {
  const dot = DOT[step.kind];
  const style = { "--d": `${delayMs}ms` } as React.CSSProperties;
  return (
    <li className="anim-rise relative grid grid-cols-[20px_minmax(0,1fr)] gap-3 pb-4" style={style}>
      {!last && <span aria-hidden="true" className="anim-grow-y absolute top-6 bottom-1 left-[9px] w-0.5 bg-gray-200" style={style} />}
      <span className={`anim-pop mt-0.5 grid h-5 w-5 place-items-center rounded-full text-white ${dot.bg}`} style={style}>
        <Icon name={dot.icon} />
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex justify-between gap-2 text-sm">
          <span className={`min-w-0 break-words ${step.kind === "tool" ? "font-mono text-[13px]" : ""}`}>{step.label}</span>
          <span className="shrink-0 font-mono text-[11px] text-gray-400">{step.offsetMs === 0 ? "0 ms" : `+${fmtMs(step.offsetMs)}`}</span>
        </div>
        {step.outcomes.map((o, j) => (
          // Kural sonucu: adımın kendisinden biraz sonra, yaylı bir hareketle gelir.
          <span
            key={j}
            className={`anim-pop rounded-lg px-2 py-1 text-xs ${TONE[o.tone]}`}
            style={{ "--d": `${delayMs + 220 + j * 120}ms` } as React.CSSProperties}
          >
            {o.text}
          </span>
        ))}
      </div>
    </li>
  );
}

function Icon({ name }: { name: "dot" | "arrow" | "fn" | "pause" | "check" | "x" }) {
  const paths = {
    dot: <circle cx="12" cy="12" r="4" />,
    arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
    fn: <path d="M9 4c-2 0-3 1-3 3v10M4 10h7M14 9l6 6M20 9l-6 6" />,
    pause: <path d="M9 6v12M15 6v12" />,
    check: <path d="M20 6 9 17l-5-5" />,
    x: <path d="M6 6l12 12M18 6 6 18" />,
  };
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[11px] w-[11px] fill-none stroke-current stroke-[3] [stroke-linecap:round] [stroke-linejoin:round]">
      {paths[name]}
    </svg>
  );
}
