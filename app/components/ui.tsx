/** Sayfalar arasında paylaşılan küçük parçalar. */

export function TicketPill({ status }: { status: "open" | "approved" | "rejected" }) {
  const cls = status === "open" ? "bg-amber-100 text-amber-800" : status === "approved" ? "bg-emerald-100 text-emerald-700" : "bg-gray-200 text-gray-700";
  return <span className={`rounded-full px-2 py-0.5 text-xs ${cls}`}>{status}</span>;
}

