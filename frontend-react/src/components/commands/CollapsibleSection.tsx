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
import type { CSSProperties, ReactNode } from 'react';

export function CollapsibleSection({
  sectionKey,
  headerContent,
  collapsed,
  onToggleChevron,
  extraClass,
  renderBody,
  style,
  rootDataAttrs,
  headerDataAttrs,
  bodyDataAttrs,
}: {
  sectionKey: string;
  headerContent: ReactNode;
  collapsed: boolean;
  onToggleChevron: () => void;
  extraClass?: string;
  renderBody: () => ReactNode;
  // Fatia 5b (Pastas — drag-and-drop): style inline + atributos `data-*`
  // extras no próprio wrapper `.section`/`.sec-title`/`.sec-body` —
  // FolderSection.tsx precisa desses três elementos carregando
  // `data-folder-id`/`data-root-folder-id` (no `.section`),
  // `data-folder-header-id` (no `.sec-title`) e `data-folder-body-id` (no
  // `.sec-body`) NO MESMO NÍVEL que o original (buildFolderSectionFromCards,
  // js/db-render-engine.js: html.replace(...) grava os três atributos
  // direto nesses elementos, nunca num wrapper extra por fora) — o
  // mecanismo de drag (useFolderDrag.ts) depende de `.sec-body` ser filho
  // DIRETO do elemento com `data-folder-id` (`:scope > .sec-body`, mesma
  // lógica do original), o que exigiria um wrapper a mais se esses
  // atributos não pudessem ser colocados aqui. Opcionais e sem efeito
  // nenhum pros demais usos deste componente (Tópico/Created by/Version),
  // que nunca os passam.
  style?: CSSProperties;
  rootDataAttrs?: Record<string, string | number>;
  headerDataAttrs?: Record<string, string | number>;
  bodyDataAttrs?: Record<string, string | number>;
}) {
  return (
    <div
      className={`section${extraClass ? ' ' + extraClass : ''}${collapsed ? ' collapsed' : ''}`}
      data-sec-key={sectionKey}
      style={style}
      {...rootDataAttrs}
    >
      <div className="sec-title" {...headerDataAttrs}>
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
      <div className="sec-body" {...bodyDataAttrs}>{!collapsed && renderBody()}</div>
    </div>
  );
}
