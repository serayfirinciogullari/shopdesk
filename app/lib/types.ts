/**
 * MongoDB document tipleri.
 * Collection ≈ PostgreSQL tablosu, document ≈ satır; ama document iç içe dizi/nesne
 * taşıyabilir (Firestore'daki gibi). Örn. bir sohbetin mesajları ayrı tabloda değil,
 * sohbet document'ının içinde `messages` dizisi olarak durur.
 */
import type { ObjectId } from "mongodb";

export type OrderStatus = "processing" | "shipped" | "delivered" | "cancelled";

export interface OrderItem {
  sku: string;
  name: string;
  price: number;
  qty: number;
  finalSale: boolean;
}

export interface Order {
  _id?: ObjectId;
  orderNumber: string; // "#1042"
  email: string; // her zaman küçük harf
  customerName: string;
  status: OrderStatus;
  items: OrderItem[];
  total: number;
  currency: "TRY";
  createdAt: Date;
  shippedAt?: Date;
  deliveredAt?: Date;
  trackingUrl?: string;
}

export type ConversationStatus = "bot" | "escalated" | "resolved";

export interface Message {
  role: "customer" | "agent" | "human";
  text: string;
  at: Date;
  runId?: string; // ajan mesajları hangi run'dan çıktı (Aşama 3'te "trace'i gör" linki)
}

export interface Conversation {
  _id?: ObjectId;
  customerEmail?: string;
  status: ConversationStatus;
  messages: Message[];
  createdAt: Date;
  updatedAt: Date;
}

/** Bir run'ın tek adımı. */
export interface Span {
  type: "agent" | "handoff" | "tool" | "guardrail" | "model";
  name: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  startedAt: Date;
  durationMs: number;
  // Yalnızca model adımlarında:
  provider?: string;
  model?: string;
  fallbackReason?: string;
  tokens?: { input: number; output: number; total: number };
}

export interface Trace {
  _id?: ObjectId;
  runId: string;
  conversationId: ObjectId;
  input: string; // müşterinin bu run'ı başlatan mesajı
  finalOutput?: string;
  lastAgent?: string;
  status: "ok" | "error";
  error?: string;
  startedAt: Date;
  durationMs: number;
  usage: { requests: number; inputTokens: number; outputTokens: number; totalTokens: number };
  spans: Span[];
}
