/**
 * Bütün sayfalarda aynı üst menü (root.tsx'te, Outlet'in üstünde).
 *
 * Düzen lookfor'un sitesindeki gibi: solda logo, ortada hap şeklinde bir kutuda linkler,
 * sağda "Code" ve siyah "Try a scenario". Aktif linkin arkasındaki koyu dolgu sayfa
 * değişince yeni linke kayar (ölçüm tarayıcıda; ölçülene kadar aktif link kendi dolgusunu
 * taşır, yani JS olmadan da doğru görünür). Kaydırınca altta ince çizgi ve buzlu zemin.
 */
import { useLayoutEffect, useRef, useState, useEffect } from "react";
import { Link, NavLink, useLocation } from "react-router";

const REPO_URL = "https://github.com/serayfirinciogullari/shopdesk";

/** Menü yüksekliği: sohbet ekranı kendi yüksekliğini buna göre hesaplar (h-[calc(100dvh-4rem)]). */
export const NAV_HEIGHT = "4rem";

export function SiteNav({ openTickets }: { openTickets: number | null }) {
  const { pathname } = useLocation();
  const onTrace = pathname.startsWith("/traces/");
  const items = [
    { to: "/chat", label: "Chat", match: (p: string) => p.startsWith("/chat") },
    { to: "/inbox", label: "Inbox", match: (p: string) => p.startsWith("/inbox"), badge: openTickets },
    ...(onTrace ? [{ to: pathname, label: "Trace", match: () => true }] : []),
    { to: "/tests", label: "Tests", match: (p: string) => p.startsWith("/tests") },
  ];
  const activeIndex = items.findIndex((i) => i.match(pathname));

  // Kayan dolgu: aktif linkin konumunu ölç.
  const groupRef = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const el = groupRef.current?.querySelector<HTMLElement>(`[data-i="${activeIndex}"]`);
      setPill(el ? { left: el.offsetLeft, width: el.offsetWidth } : null);
    };
    measure();
    // Yazı tipi sonradan yüklenirse link genişlikleri değişir: bir kez daha ölç.
    document.fonts?.ready.then(measure);
  }, [activeIndex, items.length, openTickets]);

  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`sticky top-0 z-40 border-b transition-[background-color,border-color] duration-300 ${
        scrolled ? "border-gray-200 bg-gray-50/80 backdrop-blur-md" : "border-transparent bg-gray-50"
      }`}
      style={{ height: NAV_HEIGHT }}
    >
      <div className="mx-auto flex h-full max-w-7xl items-center gap-3 px-4 sm:px-6">
        <Link to="/" className="group flex shrink-0 items-center gap-2.5" aria-label="ShopDesk home">
          <span className="grid h-8 w-8 place-items-center rounded-[10px] bg-gray-900 text-white shadow-sm transition-transform duration-300 group-hover:-rotate-6">
            <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 fill-none stroke-current stroke-[2.2] [stroke-linecap:round] [stroke-linejoin:round]">
              <path d="M4 7h16l-1.5 11a2 2 0 0 1-2 1.7H7.5a2 2 0 0 1-2-1.7L4 7Z" />
              <path d="M9 7a3 3 0 0 1 6 0" />
              <path d="m9.5 13 2 2 3.5-3.5" />
            </svg>
          </span>
          <span className="hidden text-[15px] font-semibold tracking-tight sm:inline">ShopDesk</span>
          <span className="hidden rounded-full bg-violet-50 px-2 py-0.5 font-mono text-[10px] tracking-widest text-violet-700 uppercase lg:inline">demo</span>
        </Link>

        <nav aria-label="Main" className="mx-auto min-w-0">
          <div
            ref={groupRef}
            className="relative flex items-center gap-0.5 overflow-x-auto rounded-full border border-gray-200 bg-white p-1 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_4px_14px_rgba(0,0,0,0.04)] [scrollbar-width:none]"
          >
            {pill && (
              <span
                aria-hidden="true"
                className="absolute top-1 bottom-1 rounded-full bg-gray-900 transition-[left,width] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none"
                style={{ left: pill.left, width: pill.width }}
              />
            )}
            {items.map((it, i) => {
              const active = i === activeIndex;
              return (
                <NavLink
                  key={it.label}
                  to={it.to}
                  data-i={i}
                  prefetch="intent"
                  // Yeni sohbet her seferinde tam sayfa: /chat sunucuda yeni bir sohbet açıp yönlendirir.
                  reloadDocument={it.to === "/chat"}
                  aria-current={active ? "page" : undefined}
                  className={`relative z-10 flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm whitespace-nowrap transition-colors duration-200 ${
                    active ? `text-white ${pill ? "" : "bg-gray-900"}` : "text-gray-600 hover:text-gray-900"
                  }`}
                >
                  {it.label}
                  {it.badge ? (
                    <span className={`min-w-5 rounded-full px-1.5 text-center text-[11px] font-medium tabular-nums ${active ? "bg-white/20 text-white" : "bg-amber-100 text-amber-800"}`}>
                      {it.badge}
                    </span>
                  ) : null}
                </NavLink>
              );
            })}
          </div>
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-sm text-gray-600 transition-colors hover:bg-white hover:text-gray-900"
            aria-label="Source code on GitHub"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 fill-current">
              <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
            </svg>
            <span className="hidden md:inline">Code</span>
          </a>
          <Link
            to="/#try"
            className="group hidden items-center gap-2 rounded-full bg-gray-900 py-1.5 pr-1.5 pl-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-gray-800 sm:flex"
          >
            Try a scenario
            <span className="grid h-6 w-6 place-items-center rounded-full bg-white text-gray-900 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-rotate-45">
              <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3.5 w-3.5 fill-none stroke-current stroke-[2.4] [stroke-linecap:round] [stroke-linejoin:round]">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </span>
          </Link>
        </div>
      </div>
    </header>
  );
}
