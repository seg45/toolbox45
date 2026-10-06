// ════════════════════════════════════════════════
// Aba "Database" do modal de Configurações — porta de
// .settings-pane[data-pane="database"] (index.html), na MESMA ordem dos três
// grupos do original: "Commands" (Export/Import CSV do catálogo — fatia 9),
// "Folders" (Export/Import de uma pasta em .json — fatia 5c) e "Database"
// (Backup & Restore + View audit log — fatia 9, admin-only).
//
// Gate de admin: só o grupo "Database" (#sysGroupDatabase do original,
// ADMIN_ONLY_SETTINGS_GROUP_IDS em js/auth.js) — "Commands" e "Folders" são
// visíveis a qualquer usuário logado (dados do próprio usuário; o único
// pedaço admin-only de "Commands" é o checkbox "Import as System commands"
// dentro do modal de import, tratado em ImportCommandsModal.tsx). Fail-closed:
// auth.isAdmin só vira true depois que /api/me confirma o cargo (ver
// lib/auth.tsx), então o grupo nem é montado antes disso.
// ════════════════════════════════════════════════
import { useState } from 'react';
import { useAuth } from '../../lib/auth';
import { FolderExportModal } from '../commands/FolderExportModal';
import { FolderImportModal } from '../commands/FolderImportModal';
import { ExportCommandsModal } from './ExportCommandsModal';
import { ImportCommandsModal } from './ImportCommandsModal';
import { BackupManagerModal } from './BackupManagerModal';
import { AuditLogModal } from './AuditLogModal';
import { AccessLogModal } from './AccessLogModal';

type DatabaseModal = 'exportFolder' | 'importFolder' | 'exportCommands' | 'importCommands' | 'backup' | 'audit' | 'access';

export function DatabasePane({ onCatalogsChanged }: { onCatalogsChanged: () => void | Promise<unknown> }) {
  const auth = useAuth();
  const [modal, setModal] = useState<DatabaseModal | null>(null);
  const close = () => setModal(null);

  return (
    // Mesmo wrapper de index.html (.settings-pane[data-pane="database"]) e das
    // demais panes React (PreferencesPane etc.): as regras de espaçamento entre
    // grupos (`.settings-pane > .set-group + .set-group`, gap) dependem dele.
    <div className="settings-pane" data-pane="database">
      <div className="set-group">
        <span className="set-label">Commands</span>
        <div className="settings-action-row">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setModal('exportCommands')}
            title="Exports the command catalog as a .csv file — you choose the columns"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M8 2v7.5M4.5 6.5L8 10l3.5-3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M2.5 12.5h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <span>Export commands</span>
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setModal('importCommands')} title="Bulk-create commands from a .csv file.">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M8 10.5V3M4.5 6.5L8 3l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M2.5 12.5h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <span>Import commands</span>
          </button>
        </div>
      </div>

      <div className="set-group">
        <span className="set-label">Folders</span>
        <div className="settings-action-row">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setModal('exportFolder')}
            title="Exports one folder — including all its subfolders, commands and notes — as a .json file."
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M8 2v7.5M4.5 6.5L8 10l3.5-3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M2.5 12.5h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <span>Export folder</span>
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setModal('importFolder')}
            title="Recreates a folder (with subfolders, commands and notes) from a .json file exported here."
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M8 10.5V3M4.5 6.5L8 3l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M2.5 12.5h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <span>Import folder</span>
          </button>
        </div>
      </div>

      {auth.isAdmin && (
        <div className="set-group" id="sysGroupDatabase">
          <span className="set-label">Database</span>
          <div className="settings-action-row">
            <button type="button" className="btn btn-ghost" id="backupManagerBtn" onClick={() => setModal('backup')}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path d="M2 4.3c0-1.1 2.7-1.9 6-1.9s6 .8 6 1.9-2.7 1.9-6 1.9-6-.8-6-1.9z" stroke="currentColor" strokeWidth="1.3" />
                <path
                  d="M2 4.3v3.4c0 1.1 2.7 1.9 6 1.9s6-.8 6-1.9V4.3M2 7.7v3.4c0 1.1 2.7 1.9 6 1.9s6-.8 6-1.9V7.7"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                />
              </svg>
              <span>Backup &amp; Restore</span>
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setModal('audit')}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path d="M3 2.5h10v11H3z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                <path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
              <span>View audit log</span>
            </button>
            {/* Access log: login/falhas/bloqueios — só super admin (GET /api/auth-events). */}
            {auth.isSuperAdmin && (
              <button type="button" className="btn btn-ghost" id="accessLogBtn" onClick={() => setModal('access')}>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <rect x="3.5" y="7" width="9" height="6.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
                  <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
                <span>View access log</span>
              </button>
            )}
          </div>
        </div>
      )}

      {modal === 'exportCommands' && <ExportCommandsModal onClose={close} />}
      {modal === 'importCommands' && <ImportCommandsModal onClose={close} onCatalogsChanged={onCatalogsChanged} />}
      {modal === 'exportFolder' && <FolderExportModal onClose={close} />}
      {modal === 'importFolder' && <FolderImportModal onClose={close} />}
      {/* Defesa em profundidade: mesmo com o botão só existindo para admin,
          os modais admin-only também checam auth.isAdmin ao montar. */}
      {auth.isAdmin && modal === 'backup' && <BackupManagerModal onClose={close} />}
      {auth.isAdmin && modal === 'audit' && <AuditLogModal onClose={close} />}
      {auth.isSuperAdmin && modal === 'access' && <AccessLogModal onClose={close} />}
    </div>
  );
}
