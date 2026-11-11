/**
 * Canlı demo koruması: IP başına ve site geneli rate limit.
 *
 * Neden MongoDB'de? Vercel'de her istek ayrı bir fonksiyon örneğinde çalışabilir;
 * bellekteki bir sayaç (Express'teki express-rate-limit'in varsayılanı) örnekler arasında
 * paylaşılmaz. Sayaç bu yüzden `ratelimits` collection'ında tutulur. Her pencere bir
 * document: `$inc` ile atomik artar, `expiresAt` dolunca MongoDB'nin TTL index'i onu
 * kendisi siler (PostgreSQL'de zamanlanmış bir DELETE job'ı gibi).
 *
 * Gizlilik: IP adresi açık yazılmaz, tuzlu hash'in ilk 16 karakteri saklanır.
 */
import { createHash } from "node:crypto";
import { getDb } from "./db.server";

interface Counter {
  _id: string;
  count: number;
  expiresAt: Date;
}

const counters = () => getDb().collection<Counter>("ratelimits");

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const limits = () => ({
  perIp: num(process.env.RATE_LIMIT_PER_IP, 8),
  windowMin: num(process.env.RATE_LIMIT_WINDOW_MIN, 10),
  daily: num(process.env.RATE_LIMIT_DAILY, 150),
});

/** İsteği yapanın IP'si. Vercel gerçek IP'yi x-forwarded-for'un başına koyar. */
export function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "local";
}

function hashIp(ip: string) {
  return createHash("sha256").update(`shopdesk:${ip}`).digest("hex").slice(0, 16);
}

let indexReady: Promise<unknown> | undefined;

async function bump(key: string, expiresAt: Date): Promise<number> {
  indexReady ??= counters().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await indexReady;
  const doc = await counters().findOneAndUpdate(
    { _id: key },
    { $inc: { count: 1 }, $setOnInsert: { expiresAt } },
    { upsert: true, returnDocument: "after" },
  );
  return doc?.count ?? 1;
}

export type LimitResult = { ok: true } | { ok: false; message: string };

/**
 * Model çağıracak her istekten önce çağrılır (chat mesajı, Inbox kararı).
 * Sabit pencere: "10:00–10:10 arası 8 mesaj". Basit ve demo için yeterli.
 */
export async function checkRateLimit(request: Request): Promise<LimitResult> {
  if (process.env.RATE_LIMIT_DISABLED === "1") return { ok: true };
  const { perIp, windowMin, daily } = limits();
  const now = Date.now();
  const windowMs = windowMin * 60_000;
  const windowStart = Math.floor(now / windowMs) * windowMs;

  const ipCount = await bump(`ip:${hashIp(clientIp(request))}:${windowStart}`, new Date(windowStart + windowMs));
  if (ipCount > perIp) {
    const waitMin = Math.max(1, Math.ceil((windowStart + windowMs - now) / 60_000));
    return {
      ok: false,
      message: `This is a free demo, so each visitor can send ${perIp} messages every ${windowMin} minutes. Please try again in about ${waitMin} min.`,
    };
  }

  const day = new Date(now).toISOString().slice(0, 10); // UTC günü
  const dayCount = await bump(`day:${day}`, new Date(Date.parse(day) + 2 * 86_400_000));
  if (dayCount > daily) {
    return {
      ok: false,
      message: "The demo has used up today's free model quota. Please come back tomorrow, or run it locally (see the README).",
    };
  }
  return { ok: true };
}
