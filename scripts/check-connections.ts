/**
 * Aşama 0 bağlantı testi: `npm run check`
 *
 * 1. MongoDB Atlas'a bağlanır ve "ping" atar.
 * 2. Groq'taki gpt-oss modeliyle mini bir çoklu ajan sistemi çalıştırır:
 *    Triage ajanı soruyu Orders ajanına devreder (handoff), Orders ajanı
 *    sahte bir `getOrderStatus` aracını çağırır. Handoff ve tool çağrısı
 *    gerçekten olduysa model bu proje için yeterli demektir.
 * 3. Gemini anahtarı varsa aynı testi yedek modelde de dener.
 */
import "dotenv/config";
import OpenAI from "openai";
import { MongoClient } from "mongodb";
import { z } from "zod";
import {
  Agent,
  run,
  tool,
  handoff,
  OpenAIChatCompletionsModel,
  setTracingDisabled,
} from "@openai/agents";
import { removeAllTools } from "@openai/agents-core/extensions";

// SDK'nın yerleşik tracing'i OpenAI'ye veri gönderir ve OpenAI anahtarı ister.
// Biz trace'leri kendimiz MongoDB'ye yazacağız, o yüzden kapatıyoruz.
setTracingDisabled(true);

const ok = (msg: string) => console.log(`  ✅ ${msg}`);
const fail = (msg: string) => console.log(`  ❌ ${msg}`);
let failures = 0;

async function checkMongo() {
  console.log("\n[1] MongoDB Atlas");
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    fail("MONGODB_URI boş. .env dosyasını doldur.");
    failures++;
    return;
  }
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
  try {
    await client.connect();
    await client.db(process.env.MONGODB_DB || "shopdesk").command({ ping: 1 });
    ok("Bağlandım (ping başarılı).");
  } catch (e) {
    fail(`Bağlanamadım: ${(e as Error).message}`);
    console.log("     İpucu: Atlas > Network Access'te IP adresin ekli mi? Şifrede özel karakter varsa URL-encode et.");
    failures++;
  } finally {
    await client.close();
  }
}

async function checkModel(label: string, apiKey: string | undefined, baseURL: string | undefined, modelName: string | undefined) {
  console.log(`\n[${label}]`);
  if (!apiKey || !baseURL || !modelName) {
    fail("Anahtar, URL ya da model adı boş. .env dosyasını doldur.");
    failures++;
    return;
  }
  // Her sağlayıcıya kendi bağlantısı. Groq ve Gemini "Chat Completions"
  // API'sini destekliyor (OpenAI'nin yeni "Responses" API'sini değil).
  const llm = new OpenAIChatCompletionsModel(new OpenAI({ apiKey, baseURL }), modelName);

  let toolCalled = false;
  const getOrderStatus = tool({
    name: "getOrderStatus",
    description: "Look up an order. Requires order number AND the customer's email.",
    parameters: z.object({ orderNumber: z.string(), email: z.string() }),
    execute: async ({ orderNumber, email }) => {
      toolCalled = true;
      console.log(`     → araç çağrıldı: getOrderStatus(${JSON.stringify({ orderNumber, email })})`);
      return { found: true, status: "shipped", trackingUrl: "https://example.com/track/1042" };
    },
  });

  const orders = new Agent({
    name: "Orders",
    model: llm,
    instructions: "You answer order status questions. Always use getOrderStatus. Reply in one short sentence.",
    tools: [getOrderStatus],
  });
  const triage = Agent.create({
    name: "Triage",
    model: llm,
    instructions: "You route customer messages. Order status questions go to Orders. Do not answer yourself.",
    // removeAllTools: Devredilen ajan, geçmişte "transfer_to_Orders" araç
    // mesajını görünce soruyu kendine sorulmuş saymıyor ve araç çağırmadan
    // cevap uyduruyordu (gpt-oss, 11 Kasım denemesi). Filtre o mesajları siler.
    handoffs: [handoff(orders, { inputFilter: removeAllTools })],
  });

  const started = Date.now();
  try {
    const result = await run(triage, "Hi, where is my order #1042? My email is ayse@example.com");
    // removeAllTools handoff kaydını da sildiği için "son ajan kim?" diye bakıyoruz.
    const handedOff = result.lastAgent?.name === "Orders";
    const u = result.state.usage;

    handedOff ? ok("Handoff çalıştı (Triage → Orders).") : fail("Handoff olmadı.");
    toolCalled ? ok("Tool calling çalıştı.") : fail("Araç çağrılmadı.");
    if (!handedOff || !toolCalled) failures++;
    console.log(`     Cevap: ${result.finalOutput}`);
    console.log(`     Son ajan: ${result.lastAgent?.name} · ${u.requests} model çağrısı · ${u.totalTokens} token (girdi ${u.inputTokens}, çıktı ${u.outputTokens}) · ${Date.now() - started} ms`);
  } catch (e) {
    fail(`Model çağrısı başarısız: ${(e as Error).message}`);
    failures++;
  }
}

await checkMongo();
await checkModel("2 Groq", process.env.GROQ_API_KEY, process.env.GROQ_BASE_URL, process.env.MODEL);
if (process.env.GEMINI_API_KEY) {
  await checkModel("3 Gemini (yedek)", process.env.GEMINI_API_KEY, process.env.GEMINI_BASE_URL, process.env.GEMINI_MODEL);
} else {
  console.log("\n[3 Gemini (yedek)]\n  ⏭️  GEMINI_API_KEY boş, atlandı.");
}

console.log(failures === 0 ? "\nHepsi tamam. Aşama 0 bitti. 🎉" : `\n${failures} kontrol başarısız.`);
process.exit(failures === 0 ? 0 : 1);
