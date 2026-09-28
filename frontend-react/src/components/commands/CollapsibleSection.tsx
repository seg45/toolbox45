// ════════════════════════════════════════════════
// Bloco recolhível genérico — porta de collapsibleGroup()/
// collapsibleGroupLazy()/section() em js/terminal-renderer.js. Usado tanto
// para a seção de um Tópico/Ambiente quanto, nos modos "Created by"/
// "Version", para o agrupamento por autor/o bloco inteiro de uma combinação
// Versão/Ambiente.
//
// Idioma React (substitui collapsibleGroupLazy/_lazySectionBuilders do
// original): `renderBody` é uma FUNÇÃO, não um nó já pronto — só é chamada
// (e portanto só monta os componentes filhos de verdade, com todo o custo de
// safeHL() que isso implica) quando a seção NÃO está recolhida. Uma seção
// recolhida nunca paga esse custo, exatamente como o builder adiado do
// original evitava, só que via o próprio modelo de render do React em vez
// de uma máquina de builders manual.
//
// O clique de recolher/expandir fica só no ícone (.sec-chevron) — não no
// cabeçalho inteiro — mesmo ajuste feito no original a pedido do usuário
// ("ao clicar na linha as pastas estão recolhendo e expandindo, deixe essa
// ação somente ao clicar nos botões de expandir e recolher").
// ════════════════════════════════════════════════
import type { ReactNode } from 'react';

export function CollapsibleSection({
  sectionKey,
  headerContent,
  collapsed,
  onToggleChevron,
  extraClass,
  renderBody,
}: {
  sectionKey: string;
  headerContent: ReactNode;
  collapsed: boolean;
  onToggleChevron: () => void;
  extraClass?: string;
  renderBody: () => ReactNode;
}) {
  return (
    <div className={`section${extraClass ? ' ' + extraClass : ''}${collapsed ? ' collapsed' : ''}`} data-sec-key={sectionKey}>
      <div className="sec-title">
        <svg
          className="sec-chevron"
          width="8"
          height="8"
          viewBox="0 0 10 10"
          fill="none"
          onClick={onToggleChevron}
        >
          <path d="M1 2l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {headerContent}
      </div>
      <div className="sec-body">{!collapsed && renderBody()}</div>
    </div>
  );
}
