/**
 * Eval ayrı bir veritabanında çalışır (PostgreSQL'de testleri `test_db`'de koşturmak gibi):
 * her tur o veritabanını sıfırlar, demo verisine dokunmaz.
 *
 * Bu dosya run.ts'in İLK import'u olmalı: db.server.ts yüklenmeden önce
 * MONGODB_DB'yi ayarlıyoruz. dotenv var olan değişkeni ezmez, yani .env'de
 * MONGODB_DB olsa bile buradaki değer geçerli olur.
 */
process.env.MONGODB_DB = process.env.EVAL_MONGODB_DB || "shopdesk_eval";
