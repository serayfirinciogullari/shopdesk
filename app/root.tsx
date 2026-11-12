import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import type { Route } from "./+types/root";
import "./app.css";
import { collections } from "~/lib/db.server";
import { SiteNav } from "~/components/SiteNav";

/**
 * Üst menüdeki Inbox rozeti için açık ticket sayısı. Her sayfada çalışır (ucuz bir sayım);
 * veritabanına ulaşılamazsa menü rozetsiz görünür, sayfa çökmez.
 */
export async function loader() {
  try {
    return { openTickets: await collections.tickets().countDocuments({ status: "open" }) };
  } catch {
    return { openTickets: null };
  }
}

// Layout: her sayfanın ortak HTML iskeleti (Express'teki ortak şablon gibi).
export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App({ loaderData }: Route.ComponentProps) {
  return (
    <>
      <SiteNav openTickets={loaderData.openTickets} />
      <Outlet />
    </>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <>
     <SiteNav openTickets={null} />
     <main className="mx-auto max-w-2xl p-6 pt-16">
      <h1 className="text-2xl font-semibold">{message}</h1>
      <p className="mt-2 text-gray-600">{details}</p>
      {stack && (
        <pre className="mt-4 w-full overflow-x-auto rounded bg-gray-100 p-4 text-xs">
          <code>{stack}</code>
        </pre>
      )}
     </main>
    </>
  );
}
