import type { Config } from "@react-router/dev/config";

export default {
  // Sunucu tarafında render (SSR): loader/action'lar sunucuda çalışır,
  // veritabanı ve model anahtarları tarayıcıya hiç gitmez.
  ssr: true,
} satisfies Config;
