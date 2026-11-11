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
  type: "agent" | "handoff" | "tool" | "guardrail" | "model" | "approval";
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
  /** Run bir araç onayı (needsApproval) yüzünden durduysa true. */
  interrupted?: boolean;
  /** Inbox onayıyla sürdürülen run ise, durduğu ilk run. */
  resumedFrom?: string;
  startedAt: Date;
  durationMs: number;
  usage: { requests: number; inputTokens: number; outputTokens: number; totalTokens: number };
  spans: Span[];
}

/**
 * İade talebi: bir iş kaydı (siparişe bağlı, kendi yaşam döngüsü var).
 * Tutar her zaman kodda, sipariş verisinden hesaplanır; model tutar göndermez.
 */
export type ReturnStatus = "approved" | "pending_approval" | "rejected";

export interface ReturnRequest {
  _id?: ObjectId;
  conversationId: ObjectId;
  runId: string;
  orderNumber: string;
  items: { sku: string; name: string; qty: number; price: number }[];
  amount: number;
  currency: "TRY";
  reason: string;
  status: ReturnStatus;
  createdAt: Date;
  decidedAt?: Date;
  /** Inbox onayından sonra aracı çalıştıran run. */
  approvedRunId?: string;
}

/** Ticket: "bir insan baksın" iş listesi (Inbox, Aşama 3). */
export type TicketKind = "escalation" | "return_approval";

export interface Ticket {
  _id?: ObjectId;
  kind: TicketKind;
  conversationId: ObjectId;
  runId: string;
  reason: string;
  summary: string;
  suggestedAction?: string;
  returnId?: ObjectId; // return_approval ise bağlı iade talebi
  /** Onay bekleyen araç çağrısı: Aşama 3'te Inbox'tan run'ı devam ettirmek için. */
  pendingToolCall?: { toolName: string; callId?: string; arguments: string; agent: string };
  runState?: string; // RunState.toString()
  status: TicketStatus;
  createdAt: Date;
  decidedAt?: Date;
  /** Çift tıklamaya karşı kilit: karar işlenirken dolu. */
  processingAt?: Date;
  /**
   * Onay nasıl uygulandı: "resumed_run" = kayıtlı run kaldığı yerden onayla
   * sürdürüldü (araç gerçekten çalıştı); "direct_update" = kod kaydı doğrudan güncelledi.
   */
  resolution?: "resumed_run" | "direct_update" | "closed";
  resolutionRunId?: string;
  resolutionError?: string;
}

export type TicketStatus = "open" | "approved" | "rejected";
