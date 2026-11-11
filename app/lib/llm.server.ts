/**
 * Model katmanı: Groq birincil, Gemini yedek.
 *
 * SDK'nın `Model` arayüzünü saran küçük bir sınıf. Ajan her düşündüğünde (her model
 * çağrısında) önce Groq denenir; kota (429) ya da sunucu hatası (5xx, bağlantı) olursa
 * aynı istek Gemini'ye gider. Müşteri bunu görmez (DEVIR_NOTU 15.1); hangi sağlayıcının
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
      const startedAt = new Date();
      const t0 = performance.now();
      try {
        const res = await p.impl.getResponse(request);
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
        const why = fallbackReason(p.name, e);
        this.recorder.add({
          type: "model",
          name: this.agentName,
          provider: p.name,
          model: p.model,
          error: (e as Error).message,
          startedAt,
          durationMs: Math.round(performance.now() - t0),
        });
        if (!why) throw e;
        reason = why;
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
        for await (const ev of list[i].impl.getStreamedResponse(request)) {
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
