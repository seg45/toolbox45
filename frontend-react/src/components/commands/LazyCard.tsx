// ════════════════════════════════════════════════
// Montagem preguiçosa de cards (pós-corte, "paginação/virtualização").
//
// Problema medido (test/bench.mjs, dados sintéticos): o custo de montar a
// lista de comandos cresce linear com o número de cards, porque TODOS eram
// montados de uma vez (~58 nós DOM por card) — 2.000 comandos = 117 mil
// nós e ~1,8 s até o primeiro card; 5.000 = 4,2 s; digitar na busca ou
// recolher uma seção também re-renderizava tudo.
//
// Solução: cada card vira um <div> vazio com a altura reservada e só monta
// o CommandCard de verdade quando chega perto da janela de rolagem
// (IntersectionObserver com margem generosa). Ao se afastar bastante, o
// card volta a ser placeholder MANTENDO a altura medida — então a barra de
// rolagem não "pula" e o DOM vivo fica limitado ao que está por perto.
// A aparência não muda: o que está na tela é sempre o CommandCard normal.
//
// Só entra em ação acima de LAZY_CARD_THRESHOLD cards (ver
// CommandsContent.tsx); abaixo disso o comportamento é exatamente o antigo.
// Limitação conhecida (inerente a qualquer virtualização): o Ctrl+F do
// navegador só enxerga os cards montados — a busca do próprio app (campo
// de busca/tags) opera sobre os dados e continua achando tudo.
// ════════════════════════════════════════════════
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CommandCard } from './CommandCard';

type CardProps = Parameters<typeof CommandCard>[0];

/** Acima disto (total de cards na tela) a lista passa a montar sob demanda. */
export const LAZY_CARD_THRESHOLD = 150;

// Altura média dos cards já medidos — estimativa pros placeholders ainda
// nunca montados (cards variam de ~70px a vários centenas, conforme as linhas).
let avgHeight = 96;
let measuredCount = 0;
function recordHeight(h: number) {
  if (h <= 0) return;
  measuredCount = Math.min(measuredCount + 1, 200);
  avgHeight += (h - avgHeight) / measuredCount;
}

// Um único observer compartilhado (um por card seria caro com milhares).
// Montar: margem de 900px acima/abaixo. Desmontar: só quando sai de uma
// margem maior (2400px) — histerese pra não montar/desmontar na borda.
type Cb = (near: boolean) => void;
const mountCbs = new Map<Element, Cb>();
const keepCbs = new Map<Element, Cb>();
let mountIO: IntersectionObserver | null = null;
let keepIO: IntersectionObserver | null = null;
function ensureObservers() {
  if (mountIO) return;
  mountIO = new IntersectionObserver(entries => entries.forEach(e => mountCbs.get(e.target)?.(e.isIntersecting)), { rootMargin: '900px 0px' });
  keepIO = new IntersectionObserver(entries => entries.forEach(e => keepCbs.get(e.target)?.(e.isIntersecting)), { rootMargin: '2400px 0px' });
}

export function LazyCard(props: CardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const heightRef = useRef<number>(0);
  const mountedRef = useRef(false);
  mountedRef.current = mounted;

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setMounted(true);
      return;
    }
    ensureObservers();
    mountCbs.set(el, near => {
      if (near) setMounted(true);
    });
    keepCbs.set(el, far => {
      // `far` aqui é "ainda dentro da margem grande"; ao sair, desmonta
      // guardando a altura real.
      if (!far && mountedRef.current) {
        const h = el.offsetHeight;
        if (h > 0) {
          heightRef.current = h;
          recordHeight(h);
        }
        setMounted(false);
      }
    });
    mountIO!.observe(el);
    keepIO!.observe(el);
    return () => {
      mountCbs.delete(el);
      keepCbs.delete(el);
      mountIO!.unobserve(el);
      keepIO!.unobserve(el);
    };
  }, []);

  // Depois de montar, registra a altura real (alimenta a média e a reserva
  // caso o card volte a ser placeholder).
  useLayoutEffect(() => {
    if (mounted && ref.current) {
      const h = ref.current.offsetHeight;
      if (h > 0) {
        if (!heightRef.current) recordHeight(h);
        heightRef.current = h;
      }
    }
  });

  return (
    <div
      ref={ref}
      className="card-lazy"
      data-cmd-id={props.card.id}
      style={mounted ? undefined : { height: heightRef.current || Math.round(avgHeight) }}
    >
      {mounted && <CommandCard {...props} />}
    </div>
  );
}
