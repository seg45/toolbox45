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
import { Avatar } from '../Avatar';
import { RowMenu, type RowMenuItem } from '../RowMenu';
import { NewUserModal } from './NewUserModal';
import { ResetPasswordModal } from './ResetPasswordModal';

const PROTECTED_ADMIN_USERNAME = 'admin';
type StatusFilter = 'all' | 'active' | 'pending' | 'disabled';

function statusOf(u: User): 'active' | 'pending' | 'disabled' {
  if (u.disabled && !u.approved_at) return 'pending';
  return u.disabled ? 'disabled' : 'active';
}

function typeOf(u: User): string {
  return u.auth_provider === 'google' ? 'Google' : u.auth_provider === 'microsoft' ? 'Microsoft' : u.is_local ? 'Local' : 'Windows';
}

const STATUS_LABELS = { active: 'Active', pending: 'Pending approval', disabled: 'Disabled' } as const;

const USER_ROLE_LABELS: Record<string, string> = { user: 'User', admin: 'Admin', super_admin: 'Super Admin' };

export function UsersPane() {
  const confirm = useConfirm();
  const [allUsers, setAllUsers] = useState<User[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
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
  const counts = { all: allUsers?.length ?? 0, active: 0, pending: 0, disabled: 0 };
  for (const u of allUsers || []) counts[statusOf(u)] += 1;
  const filtered = allUsers
    ? allUsers.filter(u => (statusFilter === 'all' || statusOf(u) === statusFilter) && (!term || u.username.toLowerCase().includes(term)))
    : null;
  const FILTERS: { key: StatusFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'active', label: 'Active' },
    { key: 'pending', label: 'Pending approval' },
    { key: 'disabled', label: 'Disabled' },
  ];

  return (
    <div className="settings-pane" data-pane="users">
      <div className="set-group">
        <span className="set-label">Users</span>
        <div className="settings-action-row">
          <button type="button" className="btn btn-primary" onClick={() => setNewUserOpen(true)}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <circle cx="6" cy="5.5" r="2.8" stroke="currentColor" strokeWidth="1.4" />
              <path d="M1.5 14c0-2.6 2-4.2 4.5-4.2s4.5 1.6 4.5 4.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              <path d="M12 5.5v4M10 7.5h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            <span>New local user</span>
          </button>
        </div>
        <input type="text" className="set-input" placeholder="Search by username…" value={search} onChange={ev => setSearch(ev.target.value)} />
        <div className="people-filters" role="group" aria-label="Filter by status">
          {FILTERS.map(f => (
            <button
              key={f.key}
              type="button"
              className={`people-chip${statusFilter === f.key ? ' on' : ''}${f.key === 'pending' && counts.pending > 0 ? ' attention' : ''}`}
              aria-pressed={statusFilter === f.key}
              onClick={() => setStatusFilter(f.key)}
            >
              {f.label}
              <span className="people-chip-n">{counts[f.key]}</span>
            </button>
          ))}
        </div>
        <div className="audit-log-wrap people-table">
          <table className="audit-log-table">
            <thead>
              <tr>
                <th>User</th>
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
                  const status = statusOf(u);
                  const isPending = status === 'pending';
                  const isDisabled = !!u.disabled;
                  const type = typeOf(u);
                  const menu: RowMenuItem[] = [];
                  if (!isProtected && !isPending) menu.push({ label: isDisabled ? 'Enable' : 'Disable', onClick: () => toggleUserDisabled(u.username, isDisabled) });
                  if (u.is_local) menu.push({ label: 'Reset password', onClick: () => setResetPasswordUser(u.username) });
                  if (!isProtected) menu.push({ label: 'Delete', danger: true, onClick: () => deleteUserConfirm(u.username) });
                  return (
                    <tr key={u.username} className={status === 'disabled' ? 'is-disabled' : undefined}>
                      <td>
                        <div className="person">
                          <Avatar name={u.username} />
                          <div className="person-text">
                            <span className="person-name">{u.username}</span>
                            {u.handle && u.handle !== u.username && <span className="person-sub">@{u.handle}</span>}
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className={`chip chip-type chip-${type.toLowerCase()}`}>{type}</span>
                      </td>
                      <td>
                        {isProtected ? (
                          USER_ROLE_LABELS[u.role] || u.role
                        ) : (
                          <select className="set-input" value={u.role} onChange={ev => changeUserRole(u.username, ev.target.value)}>
                            <option value="user">User</option>
                            <option value="admin">Admin</option>
                            <option value="super_admin">Super Admin</option>
                          </select>
                        )}
                      </td>
                      <td>
                        <span className={`status status-${status}`}>
                          <i aria-hidden="true" />
                          {STATUS_LABELS[status]}
                        </span>
                      </td>
                      <td>
                        <div className="row-actions">
                          {isPending && !isProtected && (
                            <button type="button" className="btn btn-sm btn-primary" onClick={() => toggleUserDisabled(u.username, isDisabled)}>
                              Approve
                            </button>
                          )}
                          <RowMenu items={menu} label={`Actions for ${u.username}`} />
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
          {filtered !== null && !loadError && filtered.length === 0 && (
            <div className="audit-log-empty">{term || statusFilter !== 'all' ? 'No users match your filters.' : 'No users yet.'}</div>
          )}
        </div>
      </div>
      {newUserOpen && <NewUserModal onClose={() => setNewUserOpen(false)} onCreated={load} />}
      {resetPasswordUser && <ResetPasswordModal username={resetPasswordUser} onClose={() => setResetPasswordUser(null)} />}
    </div>
  );
}
