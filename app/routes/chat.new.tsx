import { redirect } from "react-router";
import { collections } from "~/lib/db.server";

// Sadece loader'ı olan bir route: /chat açılınca yeni boş sohbet oluşturur
// ve /chat/:id adresine yönlendirir (Express'te res.redirect gibi).
export async function loader() {
  const now = new Date();
  const { insertedId } = await collections.conversations().insertOne({
    status: "bot",
    messages: [],
    createdAt: now,
    updatedAt: now,
  });
  return redirect(`/chat/${insertedId.toHexString()}`);
}
