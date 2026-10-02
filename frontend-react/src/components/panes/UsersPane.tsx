// ════════════════════════════════════════════════
// Aba "Users" do modal de Configurações (super_admin-only, ver
// SettingsModal.tsx/lib/auth.tsx::isSuperAdmin) — porta de
// .settings-pane[data-pane="users"] (index.html) + renderUserList/
// filterUserList/changeUserRole/toggleUserDisabled/deleteUserConfirm
// (js/users-admin.js) — fatia 7. Mesmo padrão visual/estrutural de
// GroupsPane.tsx (busca client-side sobre a última lista carregada + tabela
// audit-log-*).
//
// PROTECTED_ADMIN_USERNAME duplicada aqui, mesma decisão do original
// (frontend não importa a constante do backend) — a conta local "admin" tem
// role/disabled fixos no servidor e nunca pode ser excluída.
// ════════════════════════════════════════════════
import { useEffect, useState } from 'react';
import { useConfirm } from '../../lib/useConfirm';
import { ApiError } from '../../lib/api';
import { deleteUser, listUsers, updateUserDisabled, updateUserRole, type User } from '../../lib/users';
import { NewUserModal } from './NewUserModal';
import { ResetPasswordModal } from './ResetPasswordModal';

const PROTECTED_ADMIN_USERNAME = 'admin';
const USER_ROLE_LABELS: Record<string, string> = { user: 'User', admin: 'Admin', super_admin: 'Super Admin' };

export function UsersPane() {
  const confirm = useConfirm();
  const [allUsers, setAllUsers] = useState<User[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [newUserOpen, setNewUserOpen] = useState(false);
  const [resetPasswordUser, setResetPasswordUser] = useState<string | null>(null);

  async function load() {
    setLoadError('');
    try {
      setAllUsers(await listUsers());
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : 'Failed to load users. Please try again.');
    }
  }

  useEffect(() => {
    load();
  }, []);

  // changeUserRole/toggleUserDisabled do original: em erro, recarrega a
  // lista de qualquer forma — desfaz a seleção otimista do <select> de role
  // (o DOM já tinha "mudado" pro valor escolhido antes da resposta chegar).
  async function changeUserRole(username: string, newRole: string) {
    try {
      await updateUserRole(username, newRole);
      await load();
    } catch (e) {
      alert(e instanceof ApiError ? e.message : 'Failed to change role.');
      await load();
    }
  }

  async function toggleUserDisabled(username: string, isCurrentlyDisabled: boolean) {
    try {
      await updateUserDisabled(username, !isCurrentlyDisabled);
      await load();
    } catch (e) {
      alert(e instanceof ApiError ? e.message : 'Failed to update user.');
    }
  }

  async function deleteUserConfirm(username: string) {
    const ok = await confirm(
      `Delete the user "${username}"? Windows-identified users are recreated automatically (with the default "User" role) the next time they're seen. This cannot be undone.`,
      { danger: true }
    );
    if (!ok) return;
    try {
      await deleteUser(username);
      await load();
    } catch (e) {
      alert(e instanceof ApiError ? e.message : 'Failed to delete user.');
    }
  }

  const term = search.trim().toLowerCase();
  const filtered = allUsers ? (term ? allUsers.filter(u => u.username.toLowerCase().includes(term)) : allUsers) : null;

  return (
    <div className="settings-pane" data-pane="users">
      <div className="set-group">
        <span className="set-label">Users</span>
        <div className="settings-action-row">
          <button type="button" className="btn btn-ghost" onClick={() => setNewUserOpen(true)}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <circle cx="6" cy="5.5" r="2.8" stroke="currentColor" strokeWidth="1.3" />
              <path d="M1.5 14c0-2.6 2-4.2 4.5-4.2s4.5 1.6 4.5 4.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              <path d="M12 5.5v4M10 7.5h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
            <span>New local user</span>
          </button>
        </div>
        <input
          type="text"
          className="set-input"
          placeholder="Search by username…"
          style={{ marginBottom: 2 }}
          value={search}
          onChange={ev => setSearch(ev.target.value)}
        />
        <div className="audit-log-wrap" style={{ maxHeight: '58vh' }}>
          <table className="audit-log-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Type</th>
                <th>Role</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {loadError ? (
                <tr>
                  <td colSpan={5} className="audit-log-loading">
                    {loadError}
                  </td>
                </tr>
              ) : filtered === null ? (
                <tr>
                  <td colSpan={5} className="audit-log-loading">
                    Loading…
                  </td>
                </tr>
              ) : (
                filtered.map(u => {
                  const isProtected = u.username === PROTECTED_ADMIN_USERNAME;
                  const isPending = u.disabled && !u.approved_at;
                  const isDisabled = u.disabled;
                  const type = u.auth_provider === 'google' ? 'Google' : u.is_local ? 'Local' : 'Windows';
                  return (
                    <tr key={u.username} style={isDisabled && !isPending ? { opacity: 0.5 } : undefined}>
                      <td>{u.username}</td>
                      <td>{type}</td>
                      <td>
                        {isProtected ? (
                          USER_ROLE_LABELS[u.role] || u.role
                        ) : (
                          <select className="set-input" style={{ maxWidth: 140 }} value={u.role} onChange={ev => changeUserRole(u.username, ev.target.value)}>
                            <option value="user">User</option>
                            <option value="admin">Admin</option>
                            <option value="super_admin">Super Admin</option>
                          </select>
                        )}
                      </td>
                      <td>
                        {isPending ? (
                          <span style={{ color: 'var(--yel, #E8A33D)' }}>Pending approval</span>
                        ) : isDisabled ? (
                          'Disabled'
                        ) : (
                          'Active'
                        )}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                          {!isProtected && (
                            <button type="button" className="btn btn-sm" onClick={() => toggleUserDisabled(u.username, isDisabled)}>
                              {isPending ? 'Approve' : isDisabled ? 'Enable' : 'Disable'}
                            </button>
                          )}
                          {u.is_local && (
                            <button type="button" className="btn btn-sm" onClick={() => setResetPasswordUser(u.username)}>
                              Reset password
                            </button>
                          )}
                          {!isProtected && (
                            <button type="button" className="btn btn-sm" onClick={() => deleteUserConfirm(u.username)}>
                              Delete
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
          {filtered !== null && !loadError && filtered.length === 0 && (
            <div className="audit-log-empty">{term ? 'No users match your search.' : 'No users yet.'}</div>
          )}
        </div>
      </div>
      {newUserOpen && <NewUserModal onClose={() => setNewUserOpen(false)} onCreated={load} />}
      {resetPasswordUser && <ResetPasswordModal username={resetPasswordUser} onClose={() => setResetPasswordUser(null)} />}
    </div>
  );
}
