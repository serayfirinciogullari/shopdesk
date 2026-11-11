/**
 * Model katmanı: Groq birincil, Gemini yedek.
 *
 * SDK'nın `Model` arayüzünü saran küçük bir sınıf. Ajan her düşündüğünde (her model
 * çağrısında) önce Groq denenir; kota (429) ya da sunucu hatası (5xx, bağlantı) olursa
 * aynı istek Gemini'ye gider (kısa bir "şu kadar sn sonra dene" 429'unda önce bekleyip
 * Groq bir kez daha denenir). Müşteri bunu görmez (DEVIR_NOTU 15.1); hangi sağlayıcının
 * kullanıldığı ve neden geçildiği sadece trace'e yazılır.
 *
 * Not (DEVIR_NOTU 14): `setDefaultOpenAIClient` ikinci kez çağrılınca sağlayıcı
 * değişmiyor; bu yüzden her sağlayıcı kendi `OpenAIChatCompletionsModel`'ini alır.
 */
import "dotenv/config";
import OpenAI from "openai";
import { OpenAIChatCompletionsModel, setTracingDisabled } from "@openai/agents";
import type { Model, ModelRequest, ModelResponse } from "@openai/agents";
import type { RunRecorder } from "./trace.server";

// SDK'nın yerleşik tracing'i OpenAI'ye veri gönderir; biz kendi trace'imizi tutuyoruz.
setTracingDisabled(true);

interface Provider {
  name: "groq" | "gemini";
  model: string;
  impl: OpenAIChatCompletionsModel;
}

function makeProviders(): Provider[] {
  const list: Provider[] = [];
  const { GROQ_API_KEY, GROQ_BASE_URL, MODEL, GEMINI_API_KEY, GEMINI_BASE_URL, GEMINI_MODEL } = process.env;
  if (GROQ_API_KEY && MODEL) {
    // maxRetries 1: kota dolmuşsa uzun uzun beklemek yerine hızlıca yedeğe geçelim.
    const client = new OpenAI({ apiKey: GROQ_API_KEY, baseURL: GROQ_BASE_URL, maxRetries: 1, timeout: 30_000 });
    list.push({ name: "groq", model: MODEL, impl: new OpenAIChatCompletionsModel(client, MODEL) });
  }
  if (GEMINI_API_KEY && GEMINI_MODEL) {
    const client = new OpenAI({ apiKey: GEMINI_API_KEY, baseURL: GEMINI_BASE_URL, maxRetries: 1, timeout: 30_000 });
    list.push({ name: "gemini", model: GEMINI_MODEL, impl: new OpenAIChatCompletionsModel(client, GEMINI_MODEL) });
  }
  if (list.length === 0) throw new Error("No model provider configured (.env: GROQ_API_KEY / GEMINI_API_KEY).");
  return list;
}

let providers: Provider[] | undefined;
const getProviders = () => (providers ??= makeProviders());

/** Yedeğe geçmeyi gerektiren hata mı? Kota, sunucu hatası ya da bağlantı sorunu. */
function fallbackReason(provider: string, e: unknown): string | null {
  if (e instanceof OpenAI.APIConnectionError) return `${provider} connection error`;
  if (e instanceof OpenAI.APIError) {
    const status = e.status ?? 0;
    if (status === 429 || status >= 500) return `${provider} ${status}`;
    return null; // 400/401 gibi hatalar bizim hatamız; yedeğe geçmek sorunu gizler
  }
  return null;
}

/**
 * Groq "dakikalık token sınırı doldu, 1.1 sn sonra dene" (429) derse ne kadar beklenir?
 * Kısa bir bekleme (≤ 10 sn) varsa aynı sağlayıcıda kalmak, yedeğe geçmekten iyidir:
 * run boyunca tek model çalışır, cevaplar tutarlı kalır. Süre yoksa ya da uzunsa null.
 */
const MAX_RETRY_WAIT_MS = 10_000;
function shortRetryDelayMs(e: unknown): number | null {
  if (!(e instanceof OpenAI.APIError) || e.status !== 429) return null;
  let ms: number | null = null;
  const header = e.headers?.get?.("retry-after");
  if (header && /^\d+(\.\d+)?$/.test(header)) ms = Number(header) * 1000;
  // Groq mesajı: "Please try again in 1.1325s" / "in 850ms" / "in 1m2.5s" (dakikalı olan uzun sayılır)
  const m = /try again in (\d+(?:\.\d+)?)(ms|s)\b/i.exec(e.message);
  if (m && !/try again in \d+m\d/i.test(e.message)) ms = Math.max(ms ?? 0, m[2] === "ms" ? Number(m[1]) : Number(m[1]) * 1000);
  if (ms === null || ms > MAX_RETRY_WAIT_MS) return null;
  return Math.ceil(ms) + 500; // biraz pay: sınır kayan pencereyle hesaplanıyor
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Gemini 3, kendi ürettiği her araç çağrısına bir "thought signature" (imza) ekler ve
 * geçmişte imzasız araç çağrısı görünce 400 verir. Run ortasında Groq'tan geçince geçmişte
 * Groq'un yaptığı çağrılar imzasızdır. Gemini dokümanı (Thought signatures FAQ) başka
 * modelden aktarılan geçmiş için bu sahte imzayı öneriyor; OpenAI uyumlu endpoint'te alan
 * `tool_calls[].extra_content.google.thought_signature` (11.11.2026'da denenerek doğrulandı).
 * SDK, function_call öğesinin `providerData`'sını tool_call'a olduğu gibi ekliyor.
 */
const GEMINI_DUMMY_SIGNATURE = "skip_thought_signature_validator";
function withGeminiSignatures(request: ModelRequest): ModelRequest {
  if (typeof request.input === "string") return request;
  let changed = false;
  const input = request.input.map((item) => {
    if (item.type !== "function_call") return item;
    const pd = (item.providerData ?? {}) as Record<string, any>;
    if (pd.extra_content?.google?.thought_signature) return item; // Gemini'nin kendi imzası
    changed = true;
    return {
      ...item,
      providerData: { ...pd, extra_content: { ...pd.extra_content, google: { ...pd.extra_content?.google, thought_signature: GEMINI_DUMMY_SIGNATURE } } },
    };
  });
  return changed ? { ...request, input } : request;
}

/**
 * Ters yön: Gemini'nin ürettiği öğeler `providerData.extra_content` (imzası) taşır; SDK
 * bunu mesaja ekler ve Groq "property 'extra_content' is unsupported" diye 400 verir.
 * Groq'a giden istekte bu alanı çıkarıyoruz (geçmişteki kayıt değişmez, sadece istek).
 */
function withoutGeminiFields(request: ModelRequest): ModelRequest {
  if (typeof request.input === "string") return request;
  let changed = false;
  const input = request.input.map((item) => {
    const pd = (item as { providerData?: Record<string, unknown> }).providerData;
    if (!pd || !("extra_content" in pd)) return item;
    changed = true;
    const { extra_content: _drop, ...rest } = pd;
    return { ...item, providerData: rest } as typeof item;
  });
  return changed ? { ...request, input } : request;
}

/** Her sağlayıcıya geçmişi onun kabul ettiği biçimde gönder. */
const prepare = (p: Provider, request: ModelRequest) =>
  p.name === "gemini" ? withGeminiSignatures(request) : withoutGeminiFields(request);

/** Her run için yeni bir tane oluşturulur; model adımlarını o run'ın defterine yazar. */
export class FallbackModel implements Model {
  constructor(
    private recorder: RunRecorder,
    private agentName: string,
  ) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const list = getProviders();
    let reason: string | undefined;
    let lastError: unknown;

    for (const p of list) {
      const req = prepare(p, request);
      for (let attempt = 0; ; attempt++) {
        const startedAt = new Date();
        const t0 = performance.now();
        try {
          const res = await p.impl.getResponse(req);
          this.recorder.add({
            type: "model",
            name: this.agentName,
            provider: p.name,
            model: p.model,
            ...(reason && { fallbackReason: reason }),
            startedAt,
            durationMs: Math.round(performance.now() - t0),
            tokens: { input: res.usage.inputTokens, output: res.usage.outputTokens, total: res.usage.totalTokens },
          });
          return res;
        } catch (e) {
          lastError = e;
          const wait = attempt === 0 ? shortRetryDelayMs(e) : null;
          this.recorder.add({
            type: "model",
            name: this.agentName,
            provider: p.name,
            model: p.model,
            error: `${(e as Error).message}${wait !== null ? ` (retrying ${p.name} in ${wait} ms)` : ""}`,
            startedAt,
            durationMs: Math.round(performance.now() - t0),
          });
          if (wait !== null) {
            await sleep(wait);
            continue; // aynı sağlayıcıyı bir kez daha dene
          }
          const why = fallbackReason(p.name, e);
          if (!why) throw e;
          reason = why;
          break; // sıradaki sağlayıcıya geç
        }
      }
    }
    throw lastError;
  }

  // Aşama 1'de streaming kullanmıyoruz; yine de arayüz bunu istiyor.
  // Yedeğe geçiş sadece ilk olay gelmeden önceki hatalarda yapılır.
  async *getStreamedResponse(request: ModelRequest) {
    const list = getProviders();
    for (let i = 0; i < list.length; i++) {
      let started = false;
      try {
        for await (const ev of list[i].impl.getStreamedResponse(prepare(list[i], request))) {
          started = true;
          yield ev;
        }
        return;
      } catch (e) {
        if (started || i === list.length - 1 || !fallbackReason(list[i].name, e)) throw e;
      }
    }
  }
}
