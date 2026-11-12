/** Sayfalar arasında paylaşılan küçük parçalar. */
import { Link } from "react-router";

export function TicketPill({ status }: { status: "open" | "approved" | "rejected" }) {
  const cls = status === "open" ? "bg-amber-100 text-amber-800" : status === "approved" ? "bg-emerald-100 text-emerald-700" : "bg-gray-200 text-gray-700";
  return <span className={`rounded-full px-2 py-0.5 text-xs ${cls}`}>{status}</span>;
}

export function Nav() {
  return (
    <nav className="flex items-center justify-between border-b border-gray-200 pb-3 text-sm">
      <Link to="/" className="text-lg font-semibold">ShopDesk</Link>
      <div className="flex gap-4 text-gray-600">
        <Link to="/chat" reloadDocument className="underline">New chat</Link>
        <Link to="/inbox" className="underline">Inbox</Link>
        <Link to="/tests" className="underline">Tests</Link>
      </div>
    </nav>
  );
}
