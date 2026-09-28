// ════════════════════════════════════════════════
// Tags de escopo (Vendor/System/Version/Environment) no cabeçalho do card —
// porta de scopeLabelColor/buildScopeTag/scopeTagsHtml em
// js/terminal-renderer.js.
// ════════════════════════════════════════════════
import type { Catalogs, CatalogEntry } from '../../lib/catalogs';

function scopeLabelColor(catalogArr: CatalogEntry[] | undefined, key: string): { label: string; color: string } {
  const it = (catalogArr || []).find(x => x.key === key);
  return it ? { label: it.label, color: it.color || '#8B949E' } : { label: key, color: '#8B949E' };
}

// Uma tag de escopo (Vendor/System/Version/Environment) — array vazio =
// "aplica a todos" (mesma convenção de command_vendors/etc.), mostrado como
// um rótulo neutro em vez de listar tudo. Com 1+ valores, mostra os rótulos
// (separados por vírgula) com um "pip" colorido na cor do primeiro item
// cadastrado no catálogo.
function ScopeTag({ keys, catalogArr, allLabel }: { keys: string[]; catalogArr: CatalogEntry[] | undefined; allLabel: string }) {
  if (!keys || !keys.length) return <span className="scope-tag scope-tag-empty">{allLabel}</span>;
  const items = keys.map(k => scopeLabelColor(catalogArr, k));
  const label = items.map(it => it.label).join(', ');
  return (
    <span className="scope-tag">
      <span className="sb-pip" style={{ background: items[0].color }}></span>
      {label}
    </span>
  );
}

export function ScopeTags({
  vendors,
  systems,
  versions,
  environments,
  catalogs,
}: {
  vendors: string[];
  systems: string[];
  versions: string[];
  environments: string[];
  catalogs: Catalogs | null;
}) {
  return (
    <span className="scope-tags">
      <ScopeTag keys={vendors} catalogArr={catalogs?.vendors} allLabel="All vendors" />
      <ScopeTag keys={systems} catalogArr={catalogs?.systems} allLabel="All systems" />
      <ScopeTag keys={versions} catalogArr={catalogs?.versions} allLabel="All versions" />
      <ScopeTag keys={environments} catalogArr={catalogs?.environments} allLabel="All environments" />
    </span>
  );
}
