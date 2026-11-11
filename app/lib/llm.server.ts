/**
 * Model katmanı: sağlayıcı zinciri (varsayılan Groq birincil, Gemini yedek; MODEL_CHAIN).
 *
 * SDK'nın `Model` arayüzünü saran küçük bir sınıf. Ajan her düşündüğünde (her model
 * çağrısında) önce zincirin ilk modeli denenir; kota (429) ya da sunucu hatası (5xx,
 * bağlantı) olursa aynı istek sıradakine gider (kısa bir "şu kadar sn sonra dene" 429'unda önce bekleyip
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

const DEFAULT_BASE_URL: Record<Provider["name"], string> = {
  groq: "https://api.groq.com/openai/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/",
};

/**
 * Sağlayıcı sırası `.env`'den okunur (DEVIR_NOTU 18 kararı):
 *   MODEL_CHAIN=groq:openai/gpt-oss-120b,groq:openai/gpt-oss-20b,gemini:gemini-3.5-flash
 * Groq'ta kota model başına ayrı, yani iki Groq modeli iki ayrı kota demek.
 * MODEL_CHAIN yoksa eski davranış: MODEL (Groq) → GEMINI_MODEL (Gemini).
 */
export function parseModelChain(env: NodeJS.ProcessEnv = process.env): { name: Provider["name"]; model: string }[] {
  const raw = env.MODEL_CHAIN?.trim();
  if (!raw) {
    const legacy: { name: Provider["name"]; model: string }[] = [];
    if (env.MODEL) legacy.push({ name: "groq", model: env.MODEL });
    if (env.GEMINI_MODEL) legacy.push({ name: "gemini", model: env.GEMINI_MODEL });
    return legacy;
  }
  return raw.split(",").map((entry) => {
    const i = entry.indexOf(":");
    const name = entry.slice(0, i).trim();
    const model = entry.slice(i + 1).trim();
    if (i < 0 || (name !== "groq" && name !== "gemini") || !model) {
      throw new Error(`MODEL_CHAIN entry "${entry}" must look like groq:<model> or gemini:<model>.`);
    }
    return { name, model };
  });
}

function makeProviders(): Provider[] {
  const keys = { groq: process.env.GROQ_API_KEY, gemini: process.env.GEMINI_API_KEY };
  const baseURLs = { groq: process.env.GROQ_BASE_URL, gemini: process.env.GEMINI_BASE_URL };
  const list: Provider[] = [];
  for (const { name, model } of parseModelChain()) {
    const apiKey = keys[name];
    if (!apiKey) continue; // anahtarı olmayan sağlayıcı atlanır
    // maxRetries 1: kota dolmuşsa uzun uzun beklemek yerine hızlıca sıradakine geçelim.
    const client = new OpenAI({ apiKey, baseURL: baseURLs[name] || DEFAULT_BASE_URL[name], maxRetries: 1, timeout: 30_000 });
    list.push({ name, model, impl: new OpenAIChatCompletionsModel(client, model) });
  }
  if (list.length === 0) throw new Error("No model provider configured (.env: MODEL_CHAIN or MODEL/GEMINI_MODEL, plus API keys).");
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
