import { type RouteConfig, index, route } from "@react-router/dev/routes";

// Express'teki app.get("/chat", ...) satırlarının karşılığı: URL → dosya eşlemesi.
export default [
  index("routes/home.tsx"),
  route("chat", "routes/chat.new.tsx"), // yeni sohbet açar, /chat/:id'ye yönlendirir
  route("chat/:conversationId", "routes/chat.tsx"),
  route("traces/:runId", "routes/trace.tsx"),
  route("inbox", "routes/inbox.tsx"),
  route("tests", "routes/tests.tsx"), // eval sonuçları ve tur geçmişi (veritabanına dokunmaz)
] satisfies RouteConfig;
