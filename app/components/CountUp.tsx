/**
 * Sayarak artan sayı (easeOutCubic). Son değer sunucuda zaten yazılı: JS yoksa, ya da
 * hareket azaltma açıksa, gerçek sayı görünür. Tarayıcıda boyamadan önce 0'a çekilir.
 */
import { useLayoutEffect, useState } from "react";

export function CountUp({ to, delayMs = 0, durationMs = 1400 }: { to: number; delayMs?: number; durationMs?: number }) {
  const [v, setV] = useState(to);

  useLayoutEffect(() => {
    if (to === 0 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return setV(to);
    setV(0);
    let raf = 0;
    const timer = window.setTimeout(() => {
      const t0 = performance.now();
      const tick = (now: number) => {
        const p = Math.min(1, (now - t0) / durationMs);
        setV(Math.round(to * (1 - Math.pow(1 - p, 3))));
        if (p < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }, delayMs);
    // Güvence: sekme arka plandaysa tarayıcı rAF'ı durdurur; sayı asla 0'da kalmasın.
    const settle = window.setTimeout(() => { cancelAnimationFrame(raf); setV(to); }, delayMs + durationMs + 100);
    return () => { clearTimeout(timer); clearTimeout(settle); cancelAnimationFrame(raf); };
  }, [to, delayMs, durationMs]);

  return <span className="tabular-nums">{v.toLocaleString("en-US")}</span>;
}
