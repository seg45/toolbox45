// ════════════════════════════════════════════════
// Aba "User preferences" do modal de Configurações — porta de index.html
// (.settings-pane[data-pane="prefs"]) + js/theme.js (tema/accent) +
// js/settings.js (demais preferências).
//
// Dark mode + Accent color funcionam de verdade (mesma lógica pessoal do
// original). Home page/Group by e os espelhos de Vendor/System/Version/
// Environment/Topic + os 4 toggles (Details/Export/Images/System
// commands) já são persistidos de verdade (useSettings(), compartilhado
// com a sidebar) — mas ainda sem nenhum efeito visível sobre uma lista de
// comandos, porque o motor que os consome (render.js/ccRefreshCascade())
// só existe a partir da fatia 3. Isto replica o próprio padrão do
// original, que já guarda essas chamadas atrás de `typeof x ===
// 'function'` — aqui elas simplesmente ainda não existem.
// ════════════════════════════════════════════════
import { ACCENT_PRESETS } from '../../lib/theme';
import { Settings } from '../../lib/settingsStore';
import type { Catalogs } from '../../lib/catalogs';
import { SegSingle, SegMulti, Toggle } from '../SegControls';

const GROUP_BY_OPTIONS = [
  { val: 'creator', label: 'Created by' },
  { val: 'topic', label: 'Topic' },
  { val: 'version', label: 'Version' },
];
const HOME_OPTIONS = [
  { val: 'folders', label: 'Folders' },
  { val: 'menu', label: 'Command' },
];

export function PreferencesPane({
  catalogs,
  settings,
  update,
  theme,
  accent,
  toggleTheme,
  setAccent,
}: {
  catalogs: Catalogs | null;
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  // Fatia 8 — usePersonalTheme() foi elevado pra AppShell.tsx (mesmo motivo
  // de useLogo() nesta mesma fatia): o listener de 'storage' que reage ao
  // user-data sync (ver lib/theme.ts/lib/userDataSync.ts) só tem efeito
  // enquanto o hook está MONTADO — preso aqui dentro, ele só reaplicava o
  // tema sincronizado de outro navegador quando o usuário abria esta aba por
  // acaso. Elevado, o hook (e seu listener) ficam montados pela sessão
  // inteira, então um tema sincronizado de outro navegador é aplicado ao
  // app imediatamente, não só quando esta tela é aberta.
  theme: 'light' | 'dark';
  accent: string;
  toggleTheme: () => void;
  setAccent: (key: string) => void;
}) {

  const vendorOptions = (catalogs?.vendors || []).map(v => ({ val: v.key, label: v.label }));
  const sysOptions = (catalogs?.systems || []).map(v => ({ val: v.key, label: v.label }));
  const versionOptions = (catalogs?.versions || []).map(v => ({ val: v.key, label: v.label }));
  const envOptions = (catalogs?.environments || []).map(v => ({ val: v.key, label: v.label }));
  const topicOptions = (catalogs?.topics || []).filter(t => !t.is_protected).map(v => ({ val: v.key, label: v.label }));

  return (
    <div className="settings-pane" data-pane="prefs">
      <div className="set-group">
        <span className="set-label">Default settings</span>
        <div className={`sb-toggle${theme === 'dark' ? ' on' : ''}`} onClick={toggleTheme}>
          <div className="set-row-half">
            <div className="tog-track">
              <div className="tog-knob"></div>
            </div>
            <span>Dark mode</span>
          </div>
          <div className="set-row-half">
            <span className="set-label">Color</span>
            <div className="accent-swatches" onClick={ev => ev.stopPropagation()}>
              {Object.keys(ACCENT_PRESETS)
                .filter(key => key !== 'white' || theme === 'dark')
                .map(key => (
                  <button
                    key={key}
                    type="button"
                    className={`accent-swatch${accent === key ? ' on' : ''}`}
                    style={{ background: ACCENT_PRESETS[key].teal }}
                    onClick={() => setAccent(key)}
                    title={key === 'teal' ? 'Toolbox45 teal (default)' : key === 'pink' ? 'Check Point pink' : key === 'white' ? 'White (dark mode only)' : key.charAt(0).toUpperCase() + key.slice(1)}
                  />
                ))}
            </div>
          </div>
        </div>
      </div>

      <div className="set-group set-group-row">
        <div className="set-row-half">
          <span className="set-label">Home page</span>
          <SegSingle label="Home page" options={HOME_OPTIONS} value={settings.home} onChange={v => update({ home: v as Settings['home'] })} />
        </div>
        <div className="set-row-half">
          <span className="set-label">Group by</span>
          <SegSingle label="Group by" options={GROUP_BY_OPTIONS} value={settings.groupBy} onChange={v => update({ groupBy: v as Settings['groupBy'] })} />
        </div>
      </div>

      <div className="set-group set-group-row">
        <span className="set-label">Vendor</span>
        <SegMulti options={vendorOptions} selected={settings.vendor} onChange={v => update({ vendor: v })} />
      </div>
      <div className="set-group set-group-row">
        <span className="set-label">System</span>
        <SegMulti options={sysOptions} selected={settings.sys} onChange={v => update({ sys: v })} />
      </div>
      <div className="set-group set-group-row">
        <span className="set-label">Version</span>
        <SegMulti options={versionOptions} selected={settings.version} onChange={v => update({ version: v })} />
      </div>
      <div className="set-group set-group-row">
        <span className="set-label">Environment</span>
        <SegMulti options={envOptions} selected={settings.env} onChange={v => update({ env: v })} />
      </div>
      <div className="set-group set-group-row">
        <span className="set-label">Topic</span>
        <SegMulti options={topicOptions} selected={settings.type} onChange={v => update({ type: v })} />
      </div>

      <div className="set-group">
        <Toggle label="Details" on={settings.showCardDetails} onClick={() => update({ showCardDetails: !settings.showCardDetails })} />
        <Toggle label="Export" on={settings.exportEnabled} onClick={() => update({ exportEnabled: !settings.exportEnabled })} />
        <Toggle label="Images" on={settings.showImages} onClick={() => update({ showImages: !settings.showImages })} />
        <Toggle label="System commands" on={settings.showSystemCommands} onClick={() => update({ showSystemCommands: !settings.showSystemCommands })} />
      </div>
    </div>
  );
}
