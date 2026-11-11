/**
 * Tek MongoClient (Express'teki tek `pg.Pool` gibi).
 * `.server.ts` uzantısı: React Router bu dosyayı tarayıcı paketine asla koymaz,
 * bağlantı adresi ve şifre sunucuda kalır.
 */
import "dotenv/config";
import { MongoClient, type Db } from "mongodb";
import type { Conversation, Order, ReturnRequest, Ticket, Trace } from "./types";

declare global {
  // Geliştirmede dosya her kaydedildiğinde modül yeniden yüklenir; bağlantıyı
  // global'de saklamazsak her kayıtta yeni bir bağlantı havuzu açılır.
  var __mongoClient: MongoClient | undefined;
}

function getClient(): MongoClient {
  if (!globalThis.__mongoClient) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error("MONGODB_URI is not set (.env).");
    globalThis.__mongoClient = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
  }
  return globalThis.__mongoClient;
}

export function getDb(): Db {
  // MongoClient ilk sorguda kendiliğinden bağlanır, ayrıca connect() gerekmez.
  return getClient().db(process.env.MONGODB_DB || "shopdesk");
}

export const collections = {
  orders: () => getDb().collection<Order>("orders"),
  conversations: () => getDb().collection<Conversation>("conversations"),
  traces: () => getDb().collection<Trace>("traces"),
  returns: () => getDb().collection<ReturnRequest>("returns"),
  tickets: () => getDb().collection<Ticket>("tickets"),
};

export async function closeDb() {
  await globalThis.__mongoClient?.close();
  globalThis.__mongoClient = undefined;
}
