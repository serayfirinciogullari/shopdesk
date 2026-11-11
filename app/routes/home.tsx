import { Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/home";
import { createConversation } from "~/lib/chat.server";
import { resetDemoOrder } from "~/lib/demo.server";
import { demoScenarios, findScenario } from "~/lib/demo-scenarios";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "ShopDesk · AI support demo" },
    { name: "description", content: "A Shopify-style support agent whose rules live in code." },
  ];
}

/**
 * "Try these" butonu: o senaryonun siparişini temizle, yeni sohbet aç, mesajı hazır
 * doldurulmuş olarak göster (mesajı ziyaretçi gönderir; model burada çağrılmaz).
 */
export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const scenario = findScenario(String(form.get("scenario") ?? ""));
  if (!scenario) return redirect("/chat");
  await resetDemoOrder(scenario.orderNumber);
  const id = await createConversation();
  return redirect(`/chat/${id.toHexString()}?try=${scenario.id}`);
}

export default function Home() {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" ? String(navigation.formData?.get("scenario") ?? "") : null;

  return (
    <main className="mx-auto max-w-2xl p-6 pt-12 pb-16">
      <h1 className="text-3xl font-semibold">ShopDesk</h1>
      <p className="mt-3 text-gray-600">
        A small customer-support agent for a demo store, built with the OpenAI Agents SDK. The refund
        rules live in code, so the agent can't be talked into a wrong refund. When it isn't sure, it
        hands off to a human, and every step it takes is traced.
      </p>
      <div className="mt-5 flex flex-wrap gap-3 text-sm">
        <Link to="/chat" className="rounded-lg bg-gray-900 px-4 py-2 text-white hover:bg-gray-700">
          Start an empty chat
        </Link>
        <Link to="/inbox" className="rounded-lg border border-gray-300 px-4 py-2 hover:bg-gray-50">
          Open the Inbox
        </Link>
      </div>

      <h2 className="mt-10 text-lg font-semibold">Try these</h2>
      <p className="mt-1 text-sm text-gray-500">
        Each one opens a new chat with the message filled in. After the reply, click “View trace” to
        see what the agent actually did.
      </p>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2">
        {demoScenarios.map((s) => (
          <li key={s.id}>
            <Form method="post">
              <input type="hidden" name="scenario" value={s.id} />
              <button
                type="submit"
                disabled={busy !== null}
                className="h-full w-full rounded-xl border border-gray-200 bg-white p-4 text-left hover:border-gray-400 disabled:opacity-60"
              >
                <span className="block font-medium">
                  {s.title} <span className="text-gray-400">· {s.orderNumber}</span>
                </span>
                <span className="mt-1 block text-sm text-gray-600">{s.expect}</span>
                {busy === s.id && <span className="mt-2 block text-xs text-gray-400">Opening…</span>}
              </button>
            </Form>
          </li>
        ))}
      </ul>

      <p className="mt-8 text-xs text-gray-400">
        Free demo: runs on free model tiers, so messages are rate-limited per visitor. Store data is fake.
      </p>
    </main>
  );
}
