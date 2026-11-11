import { redirect } from "react-router";
import { createConversation } from "~/lib/chat.server";

// Sadece loader'ı olan bir route: /chat açılınca yeni boş sohbet oluşturur
// ve /chat/:id adresine yönlendirir (Express'te res.redirect gibi).
export async function loader() {
  const id = await createConversation();
  return redirect(`/chat/${id.toHexString()}`);
}
