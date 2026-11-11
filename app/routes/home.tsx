import { Link } from "react-router";
import type { Route } from "./+types/home";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "ShopDesk · AI support demo" },
    { name: "description", content: "A Shopify-style support agent whose rules live in code." },
  ];
}

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl p-6 pt-16">
      <h1 className="text-3xl font-semibold">ShopDesk</h1>
      <p className="mt-3 text-gray-600">
        A small customer-support agent for a demo store. The rules live in code, so the agent
        can't be talked into leaking someone else's order.
      </p>
      <Link
        to="/chat"
        className="mt-6 inline-block rounded-lg bg-gray-900 px-4 py-2 text-white hover:bg-gray-700"
      >
        Start a chat
      </Link>
    </main>
  );
}
