// ════════════════════════════════════════════════
// Dropdown de ESCOPO de pastas (My folders/usuário escolhido/All) — fatia
// 5b — porta de #folderScopeDD/renderFolderScopeOptions()/setFolderScope()/
// filterFolderScopeOptions()/focusFolderScopeSearch() (js/folders.js).
// Substitui "Group by" na toolbar enquanto a visão "Folders" está ativa
// (ver ContentToolbar.tsx) — os dois dropdowns nunca ficam visíveis juntos.
//
// Mesmo componente visual .dd/.dd-panel.seg dos outros dropdowns da
// toolbar (SegControls.tsx), com uma caixa de busca fixa no topo (mesmo
// padrão `.dd-search-input`, CSS já pronto desde antes desta fatia) — não
// reaproveita SegSingle/SegMulti porque nenhuma variante de lá tem esse
// campo de busca; duplicar aqui um dropdown genérico "SegSingle + busca"
// só pra este único uso não pareceu valer a complexidade extra de mais um
// parâmetro opcional numa API já usada em vários outros lugares do app.
//
// A lista cross-user (`allUsersFolders`) é carregada SOB DEMANDA por quem
// chama (`onOpen`, disparado ao abrir o dropdown) — este componente é só
// de exibição/interação, não sabe nada sobre fetch.
// ════════════════════════════════════════════════
import { useEffect, useRef, useState } from 'react';
import { folderScopeLabel, folderScopeUsernames, type FolderScope } from '../../lib/folderScope';
import type { FolderWithOwner } from '../../lib/folders';

export function FolderScopeDropdown({
  scope,
  onChange,
  allUsersFolders,
  currentUsername,
  onOpen,
}: {
  scope: FolderScope;
  onChange: (scope: FolderScope) => void;
  allUsersFolders: FolderWithOwner[] | null;
  currentUsername: string | undefined;
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(ev: MouseEvent) {
      if (ref.current && !ref.current.contains(ev.target as Node)) setOpen(false);
    }
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [open]);

  const usernames = folderScopeUsernames(allUsersFolders || [], currentUsername);
  const q = query.trim().toLowerCase();
  const filteredUsernames = q ? usernames.filter(u => u.toLowerCase().includes(q)) : usernames;

  function toggleOpen() {
    setOpen(o => {
      const next = !o;
      if (next) {
        setQuery('');
        onOpen();
        // Mesmo motivo do setTimeout(0) em focusFolderScopeSearch() no
        // original: o painel só existe no DOM depois que `open` vira true e
        // o React efetivamente re-renderiza — não dá pra focar no mesmo
        // tick síncrono do clique.
        setTimeout(() => searchRef.current?.focus(), 0);
      }
      return next;
    });
  }

  function choose(next: FolderScope) {
    onChange(next);
    setOpen(false);
  }

  return (
    <div className={`dd ctb-groupby-dd${open ? ' open' : ''}`} ref={ref}>
      <button type="button" className="dd-btn" onClick={toggleOpen}>
        <span className="dd-label">{folderScopeLabel(scope)}</span>
        <span className="dd-arrow">▾</span>
      </button>
      {open && (
        <div className="dd-panel seg">
          <input
            type="text"
            className="dd-search-input"
            ref={searchRef}
            placeholder="Search user..."
            autoComplete="off"
            value={query}
            onChange={ev => setQuery(ev.target.value)}
          />
          <button type="button" className={`seg-btn${scope === 'mine' ? ' on' : ''}`} onClick={() => choose('mine')}>
            My folders
          </button>
          {filteredUsernames.map(u => (
            <button key={u} type="button" className={`seg-btn${scope === `user:${u}` ? ' on' : ''}`} onClick={() => choose(`user:${u}`)}>
              {u}
            </button>
          ))}
          <button type="button" className={`seg-btn${scope === 'all' ? ' on' : ''}`} onClick={() => choose('all')}>
            All
          </button>
        </div>
      )}
    </div>
  );
}
