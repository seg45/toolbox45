// ════════════════════════════════════════════════
// Aba "User preferences" do modal de Configurações — porta de index.html
// (.settings-pane[data-pane="prefs"]) + js/theme.js (tema/accent) +
// js/settings.js (demais preferências).
//
// Dark mode, Accent color, Group by e os 4 toggles (Details/Export/Images/
// System commands) são aplicados e persistidos NA HORA (useSettings(),
// compartilhado com a sidebar). Home page e os espelhos de Vendor/System/
// Version/Environment/Topic (os filtros PADRÃO) ficam num rascunho e só
// valem no Save do rodapé do modal — mesmo comportamento do original.
// ════════════════════════════════════════════════
import { ACCENT_PRESETS } from '../../lib/theme';
import { Settings } from '../../lib/settingsStore';
import type { PrefsDraft } from '../SettingsModal';
import type { Catalogs } from '../../lib/catalogs';
import { SegSingle, SegMulti, Toggle } from '../SegControls';

// Cartão com título + descrição (cabeçalho do bloco) — só estrutura; o visual
// vive em components.css (#settingsOverlay .set-card).
function Card({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <section className="set-card">
      <div className="set-card-head">
        <h3 className="set-card-title">{title}</h3>
        <p className="set-card-desc">{desc}</p>
      </div>
      <div className="set-card-body">{children}</div>
    </section>
  );
}

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
  draft,
  onDraftChange,
  theme,
  accent,
  toggleTheme,
  setAccent,
}: {
  catalogs: Catalogs | null;
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  // Home page + os 5 filtros padrão (Vendor/System/Version/Environment/
  // Topic) NÃO são aplicados na hora — ficam num rascunho (`draft`, mantido
  // por SettingsModal) e só valem no botão Save do rodapé, como no original
  // (saveSettingsModal() em js/settings-modal.js). Tema, cor, Group by e os
  // 4 toggles continuam sendo aplicados e gravados na hora.
  draft: PrefsDraft;
  onDraftChange: (patch: Partial<PrefsDraft>) => void;
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
      <Card title="Appearance" desc="Theme and accent color. Applied right away and remembered for your account.">
      <div className="set-group" id="settingsToggleGroup">
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
                    id={key === 'white' ? 'accentSwatchWhite' : undefined}
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
      </Card>

      <Card title="Startup" desc="What opens first and how commands are grouped. Home page applies when you press Save.">
      <div className="set-group set-group-row">
        <div className="set-row-half">
          <span className="set-label">Home page</span>
          <SegSingle label="Home page" options={HOME_OPTIONS} value={draft.home} onChange={v => onDraftChange({ home: v as Settings['home'] })} />
        </div>
        <div className="set-row-half">
          <span className="set-label">Group by</span>
          <SegSingle label="Group by" options={GROUP_BY_OPTIONS} value={settings.groupBy} onChange={v => update({ groupBy: v as Settings['groupBy'] })} />
        </div>
      </div>
      </Card>

      <Card title="Default filters" desc="Filters pre-selected in the sidebar. Leave a row empty to show everything. Applied when you press Save.">
      <div className="set-group set-group-row">
        <span className="set-label">Vendor</span>
        <SegMulti options={vendorOptions} selected={draft.vendor} onChange={v => onDraftChange({ vendor: v })} />
      </div>
      <div className="set-group set-group-row">
        <span className="set-label">System</span>
        <SegMulti options={sysOptions} selected={draft.sys} onChange={v => onDraftChange({ sys: v })} />
      </div>
      <div className="set-group set-group-row">
        <span className="set-label">Version</span>
        <SegMulti options={versionOptions} selected={draft.version} onChange={v => onDraftChange({ version: v })} />
      </div>
      <div className="set-group set-group-row">
        <span className="set-label">Environment</span>
        <SegMulti options={envOptions} selected={draft.env} onChange={v => onDraftChange({ env: v })} />
      </div>
      <div className="set-group set-group-row">
        <span className="set-label">Topic</span>
        <SegMulti options={topicOptions} selected={draft.type} onChange={v => onDraftChange({ type: v })} />
      </div>
      </Card>

      <Card title="Command cards" desc="What each command card shows. Applied right away.">
      <div className="set-group" id="settingsToggleGroup2">
        <Toggle label="Details" on={settings.showCardDetails} onClick={() => update({ showCardDetails: !settings.showCardDetails })} />
        <Toggle label="Export" on={settings.exportEnabled} onClick={() => update({ exportEnabled: !settings.exportEnabled })} />
        <Toggle label="Images" on={settings.showImages} onClick={() => update({ showImages: !settings.showImages })} />
        <Toggle label="System commands" on={settings.showSystemCommands} onClick={() => update({ showSystemCommands: !settings.showSystemCommands })} />
      </div>
      </Card>
    </div>
  );
}
