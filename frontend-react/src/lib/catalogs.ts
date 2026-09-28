// ════════════════════════════════════════════════
// CATÁLOGO (Vendor/System/Version/Environment/Topic) — porta tipada da
// leitura feita por js/catalogs.js (só GET /api/catalogs; a administração
// do catálogo em si — criar/editar/excluir vendor/system/etc. — é
// "Register", fatia 7/8, fora do escopo desta fatia).
//
// Usado, por enquanto, só para alimentar os 5 dropdowns de filtro da
// sidebar (fatia 2) com dados reais em vez dos exemplos hardcoded do
// index.html original — a SELEÇÃO em si ainda não filtra nenhum comando
// (isso é o motor de render.js/ccRefreshCascade(), fatia 3).
// ════════════════════════════════════════════════

export interface CatalogEntry {
  key: string;
  label: string;
  color: string;
  sort_order: number;
}

export interface VersionEntry extends CatalogEntry {
  system: string;
  vendor: string;
}

export interface TopicEntry extends CatalogEntry {
  is_protected: number;
}

export interface Catalogs {
  vendors: CatalogEntry[];
  systems: (CatalogEntry & { vendor: string })[];
  versions: VersionEntry[];
  environments: (CatalogEntry & { system: string; vendor: string })[];
  topics: TopicEntry[];
}

export async function fetchCatalogs(): Promise<Catalogs> {
  const res = await fetch('/api/catalogs');
  if (!res.ok) throw new Error(`fetchCatalogs: HTTP ${res.status}`);
  return res.json();
}
