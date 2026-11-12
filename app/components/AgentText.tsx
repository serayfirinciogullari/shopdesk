/**
 * Ajanın yazdığı metni gösterir: chat, Inbox ve trace aynı bileşeni kullanır,
 * böylece müşterinin gördüğüyle temsilcinin gördüğü aynı olur.
 *
 * - Takip linklerini tıklanabilir yapar. Sondaki noktalama URL'ye dahil edilmez
 *   ("…/TR1042SD." → link "…/TR1042SD"); model bazen linki <…> içine alıyor, açılı
 *   parantezler de dahil edilmez.
 * - Model bazen Markdown kalın yazıyor ("**3649 TRY**"): yıldızları göstermek yerine kalın yazar.
 */
export function AgentText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s)<>]*[^\s).,!?;:<>])/g);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noreferrer" className="underline">
            {p}
          </a>
        ) : (
          p.split(/\*\*([^*\n]+)\*\*/g).map((q, j) => (j % 2 === 1 ? <strong key={`${i}-${j}`}>{q}</strong> : q))
        ),
      )}
    </>
  );
}
