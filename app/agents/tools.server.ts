/**
 * Araçlar (tools): ajanın çağırabildiği, bizim yazdığımız fonksiyonlar.
 *
 * Demonun kalbi: kurallar prompt'ta değil burada, kodda. Model "bu siparişi göster"
 * ya da "tam iade yap" dese bile, kural izin vermiyorsa kod bunu yapmaz.
 */
import { tool, type RunContext } from "@openai/agents";
import type { ObjectId } from "mongodb";
import { z } from "zod";
import { collections } from "~/lib/db.server";
import type { Order, OrderItem } from "~/lib/types";

/**
 * Run context: run boyunca araçlara verilen, modelin göremediği ve
 * değiştiremediği bilgi (Express'teki `req.user` gibi). Model başka bir sohbetin
 * kimliğini uyduramaz, çünkü kimlik parametre değil, buradan gelir.
 */
export interface ShopContext {
  conversationId: ObjectId;
  runId: string;
  /**
   * Yalnızca Inbox'tan onaylanan bir run'da: onaylanan bekleyen iade kaydı.
   * Uygunluk kontrolü bu kaydı "zaten iade var" saymaz ve araç yeni kayıt açmak
   * yerine bu kaydı `approved` yapar. Model bunu göremez ve değiştiremez.
   */
  approvingReturnId?: ObjectId;
}

function shopContext(ctx?: RunContext<unknown>): ShopContext {
  const c = ctx?.context as ShopContext | undefined;
  if (!c?.conversationId) throw new Error("Run context is missing conversationId");
  return c;
}

/** İade politikası: kodda, tek yerde. */
export const RETURN_WINDOW_DAYS = 30;
export const RETURN_APPROVAL_THRESHOLD = 1000; // TRY; üstü insan onayına düşer
const DAY = 24 * 60 * 60 * 1000;

/** "1042", "#1042", " #1042 " → "#1042" */
export function normalizeOrderNumber(raw: string): string | null {
  const digits = raw.replace(/[^0-9]/g, "");
  return digits ? `#${digits}` : null;
}

export function normalizeEmail(raw: string): string | null {
  const e = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

// Yanlış numara ile yanlış e-posta aynı cevabı alır; böylece "bu numaralı bir
// sipariş var mı?" bilgisi bile sızmaz.
const NOT_FOUND = {
  found: false,
  reason: "No order matches this order number and email. Do not share any order details; ask the customer to double-check both.",
} as const;

/** Numara + e-posta eşleşmezse null; çağıran hep aynı NOT_FOUND'u döner. */
async function findOwnedOrder(num: string, mail: string): Promise<Order | null> {
  const order = await collections.orders().findOne({ orderNumber: num });
  return order && order.email === mail ? order : null;
}

type Lookup = { ok: true; order: Order } | { ok: false; result: { found: false; reason: string } };

async function lookup(orderNumber: string, email: string): Promise<Lookup> {
  const num = normalizeOrderNumber(orderNumber);
  const mail = normalizeEmail(email);
  if (!num || !mail) {
    return {
      ok: false,
      result: { found: false, reason: `Missing or invalid ${!num ? "order number" : "email"}. Ask the customer for it; do not guess.` },
    };
  }
  const order = await findOwnedOrder(num, mail);
  return order ? { ok: true, order } : { ok: false, result: NOT_FOUND };
}

const orderParams = {
  orderNumber: z.string().describe("Order number as the customer wrote it, e.g. #1042"),
  email: z.string().describe("Email address the customer gave"),
};

export const getOrderStatus = tool({
  name: "getOrderStatus",
  description:
    "Look up an order's status and tracking link. Requires BOTH the order number and the email used for the order, exactly as the customer gave them. Never guess either value.",
  parameters: z.object(orderParams),
  execute: async ({ orderNumber, email }) => {
    const l = await lookup(orderNumber, email);
    if (!l.ok) return l.result;
    const order = l.order;

    // Sadece müşterinin ihtiyacı olan alanlar; e-posta, isim vb. modele hiç verilmez.
    return {
      found: true,
      orderNumber: order.orderNumber,
      status: order.status,
      items: order.items.map((i) => `${i.qty} × ${i.name}`),
      total: `${order.total} ${order.currency}`,
      orderedAt: order.createdAt.toISOString().slice(0, 10),
      shippedAt: order.shippedAt?.toISOString().slice(0, 10) ?? null,
      deliveredAt: order.deliveredAt?.toISOString().slice(0, 10) ?? null,
      trackingUrl: order.trackingUrl ?? null,
    };
  },
});

// ─── İade ──────────────────────────────────────────────────────────────────

interface ItemVerdict {
  sku: string;
  name: string;
  qty: number;
  price: number;
  eligible: boolean;
  reason: string;
}

/**
 * İade uygunluğu: demonun asıl kuralı. Hem checkReturnEligibility hem
 * createReturnRequest bunu çağırır; ikincisi modelin önceki sonucuna güvenmez.
 */
async function evaluateReturn(order: Order, opts: { excludeReturnId?: ObjectId; now?: Date } = {}): Promise<ItemVerdict[]> {
  const now = opts.now ?? new Date();
  // Bu ürünler için zaten açık ya da onaylı bir iade var mı? (Inbox'ta onaylanan
  // bekleyen kaydın kendisi sayılmaz; yoksa onay kendi kaydına takılırdı.)
  const existing = await collections
    .returns()
    .find({
      orderNumber: order.orderNumber,
      status: { $in: ["approved", "pending_approval"] },
      ...(opts.excludeReturnId ? { _id: { $ne: opts.excludeReturnId } } : {}),
    })
    .toArray();
  const alreadyReturned = new Set(existing.flatMap((r) => r.items.map((i) => i.sku)));

  const orderLevel = orderLevelBlock(order, now);
  return order.items.map((i: OrderItem) => {
    const base = { sku: i.sku, name: i.name, qty: i.qty, price: i.price };
    if (orderLevel) return { ...base, eligible: false, reason: orderLevel };
    if (i.finalSale) return { ...base, eligible: false, reason: "Final sale item: final sale items cannot be returned." };
    if (alreadyReturned.has(i.sku)) return { ...base, eligible: false, reason: "A return request for this item already exists." };
    return { ...base, eligible: true, reason: `Delivered within the last ${RETURN_WINDOW_DAYS} days and not final sale.` };
  });
}

function orderLevelBlock(order: Order, now: Date): string | null {
  switch (order.status) {
    case "processing":
      return "Order has not shipped yet, so it cannot be returned. The customer can ask to cancel it instead.";
    case "shipped":
      return "Order has not been delivered yet. A return can be requested after delivery.";
    case "cancelled":
      return "Order was cancelled, so there is nothing to return.";
  }
  if (!order.deliveredAt) return "Order has no delivery date, so eligibility cannot be confirmed.";
  const deadline = new Date(order.deliveredAt.getTime() + RETURN_WINDOW_DAYS * DAY);
  if (now > deadline) {
    const days = Math.floor((now.getTime() - order.deliveredAt.getTime()) / DAY);
    return `Return window closed: delivered ${days} days ago (${order.deliveredAt.toISOString().slice(0, 10)}); returns are accepted within ${RETURN_WINDOW_DAYS} days of delivery (deadline was ${deadline.toISOString().slice(0, 10)}).`;
  }
  return null;
}

export const checkReturnEligibility = tool({
  name: "checkReturnEligibility",
  description:
    "Check whether items in an order can be returned, with the reason for each item. Requires BOTH the order number and the email. Pass sku: null to check every item in the order.",
  parameters: z.object({
    ...orderParams,
    sku: z.string().nullable().describe("SKU of one item, or null to check all items"),
  }),
  execute: async ({ orderNumber, email, sku }) => {
    const l = await lookup(orderNumber, email);
    if (!l.ok) return l.result;
    const verdicts = await evaluateReturn(l.order);
    const items = sku ? verdicts.filter((v) => v.sku.toLowerCase() === sku.trim().toLowerCase()) : verdicts;
    if (sku && items.length === 0) {
      return { found: true, orderNumber: l.order.orderNumber, error: "That SKU is not in this order.", items: verdicts };
    }
    return { found: true, orderNumber: l.order.orderNumber, returnWindowDays: RETURN_WINDOW_DAYS, items };
  },
});

const createReturnParams = z.object({
  ...orderParams,
  skus: z.array(z.string()).min(1).describe("SKUs of the items to return (from checkReturnEligibility)"),
  reason: z.string().describe("Customer's reason for the return, in a few words"),
});
type CreateReturnInput = z.infer<typeof createReturnParams>;

/** Talep edilen ürünleri yeniden değerlendirir; tutarı kod hesaplar (model tutar göndermez). */
async function planReturn(input: CreateReturnInput, excludeReturnId?: ObjectId) {
  const l = await lookup(input.orderNumber, input.email);
  if (!l.ok) return { ok: false as const, result: { created: false, ...l.result } };
  const verdicts = await evaluateReturn(l.order, { excludeReturnId });
  const wanted = [...new Set(input.skus.map((s) => s.trim().toLowerCase()))];
  const problems: string[] = [];
  const items: ReturnType<typeof toReturnItem>[] = [];
  for (const w of wanted) {
    const v = verdicts.find((x) => x.sku.toLowerCase() === w);
    if (!v) problems.push(`${w}: not in this order`);
    else if (!v.eligible) problems.push(`${v.name}: ${v.reason}`);
    else items.push(toReturnItem(v));
  }
  if (problems.length) {
    return { ok: false as const, result: { created: false, reason: "Return not allowed.", problems } };
  }
  const amount = items.reduce((sum, i) => sum + i.price * i.qty, 0);
  return { ok: true as const, order: l.order, items, amount };
}

function toReturnItem(v: ItemVerdict) {
  return { sku: v.sku, name: v.name, qty: v.qty, price: v.price };
}

export const createReturnRequest = tool({
  name: "createReturnRequest",
  description:
    "Create a return (refund) request for eligible items. The system re-checks eligibility and computes the refund amount itself; large refunds go to a human for approval.",
  parameters: createReturnParams,
  // needsApproval: SDK, aracı çalıştırmadan ÖNCE bunu sorar. true dönerse araç
  // çalışmaz; run bir "interruption" ile durur ve bir insanın onayını bekler.
  needsApproval: async (ctx, input) => {
    const plan = await planReturn(input, (ctx?.context as ShopContext | undefined)?.approvingReturnId);
    return plan.ok && plan.amount > RETURN_APPROVAL_THRESHOLD;
  },
  execute: async (input, ctx, details) => {
    const { conversationId, runId, approvingReturnId } = shopContext(ctx);
    // Modelin önceki sonucuna güvenme, yeniden kontrol et (onay günler sonra da gelebilir).
    const plan = await planReturn(input, approvingReturnId);
    if (!plan.ok) return plan.result;

    if (plan.amount > RETURN_APPROVAL_THRESHOLD) {
      // İkinci kilit: needsApproval bir şekilde atlansa bile, bir insan bu çağrıyı
      // onaylamadıysa yüksek tutarlı iade yapılmaz.
      const callId = details?.toolCall?.callId;
      const approved = callId ? ctx?.isToolApproved({ toolName: "createReturnRequest", callId }) : undefined;
      if (approved !== true) {
        return { created: false, reason: "Refunds above the limit need human approval. Tell the customer a team member will review it." };
      }
    }

    const now = new Date();
    if (approvingReturnId) {
      // Inbox onayı: bekleyen kaydı onayla (yeni kayıt açma, çift iade olmasın).
      // Filtredeki `status` sayesinde aynı kayıt iki kez onaylanamaz.
      const { modifiedCount } = await collections
        .returns()
        .updateOne(
          { _id: approvingReturnId, status: "pending_approval" },
          { $set: { status: "approved", decidedAt: now, approvedRunId: runId } },
        );
      if (modifiedCount !== 1) {
        return { created: false, reason: "This return request was already decided. Tell the customer a team member will follow up." };
      }
      // returnId bilerek yok: model onu müşteriye "iade numarası" diye yazıyordu.
      return {
        created: true,
        status: "approved",
        approvedBy: "human team member",
        refund: `${plan.amount} TRY`,
        items: plan.items.map((i) => i.name),
        nextStep: "Tell the customer a team member approved their return. They will get a return shipping code by email; the refund is issued after the item arrives.",
      };
    }

    const { insertedId } = await collections.returns().insertOne({
      conversationId,
      runId,
      orderNumber: plan.order.orderNumber,
      items: plan.items,
      amount: plan.amount,
      currency: "TRY",
      reason: input.reason,
      status: "approved",
      createdAt: now,
      decidedAt: now,
    });
    return {
      created: true,
      returnId: insertedId.toHexString(),
      status: "approved",
      refund: `${plan.amount} TRY`,
      items: plan.items.map((i) => i.name),
      nextStep: "The customer will get a return shipping code by email; the refund is issued after the item arrives.",
    };
  },
});

/**
 * Onay bekleyen bir createReturnRequest çağrısı için iade kaydı + ticket açar.
 * run.server.ts bir interruption gördüğünde çağırır (araç hiç çalışmadan).
 */
export async function recordPendingReturn(args: {
  ctx: ShopContext;
  rawArguments: string;
  callId?: string;
  agent: string;
  runState: string;
}) {
  let input: CreateReturnInput;
  try {
    input = createReturnParams.parse(JSON.parse(args.rawArguments));
  } catch {
    return null;
  }
  const plan = await planReturn(input);
  if (!plan.ok) return null;
  const now = new Date();
  const { insertedId: returnId } = await collections.returns().insertOne({
    conversationId: args.ctx.conversationId,
    runId: args.ctx.runId,
    orderNumber: plan.order.orderNumber,
    items: plan.items,
    amount: plan.amount,
    currency: "TRY",
    reason: input.reason,
    status: "pending_approval",
    createdAt: now,
  });
  const { insertedId: ticketId } = await collections.tickets().insertOne({
    kind: "return_approval",
    conversationId: args.ctx.conversationId,
    runId: args.ctx.runId,
    reason: `Refund of ${plan.amount} TRY is above the ${RETURN_APPROVAL_THRESHOLD} TRY auto-approval limit.`,
    summary: `${plan.order.orderNumber}: return ${plan.items.map((i) => i.name).join(", ")}. Customer reason: ${input.reason}`,
    suggestedAction: "Approve the refund if the reason is valid.",
    returnId,
    pendingToolCall: { toolName: "createReturnRequest", callId: args.callId, arguments: args.rawArguments, agent: args.agent },
    runState: args.runState,
    status: "open",
    createdAt: now,
  });
  return { returnId, ticketId, amount: plan.amount };
}

// ─── İnsana devir ──────────────────────────────────────────────────────────

export const escalateToHuman = tool({
  name: "escalateToHuman",
  description:
    "Hand the conversation to a human support agent. Use when the customer is upset or angry, reports a damaged, wrong or missing item, asks for something outside what you can do, or you are not sure.",
  parameters: z.object({
    reason: z.string().describe("Why a human is needed, one short sentence"),
    summary: z.string().describe("What the customer wants and what is known so far (order number, items), 1-3 sentences"),
  }),
  execute: async ({ reason, summary }, ctx) => {
    const { conversationId, runId } = shopContext(ctx);
    const { insertedId } = await collections.tickets().insertOne({
      kind: "escalation",
      conversationId,
      runId,
      reason,
      summary,
      status: "open",
      createdAt: new Date(),
    });
    await collections
      .conversations()
      .updateOne({ _id: conversationId }, { $set: { status: "escalated", updatedAt: new Date() } });
    return {
      escalated: true,
      ticketId: insertedId.toHexString(),
      nextStep: "Tell the customer a human support agent will take over this chat shortly. Do not promise a refund or any outcome.",
    };
  },
});
