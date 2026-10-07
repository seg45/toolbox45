// ════════════════════════════════════════════════
// Aba "Groups" do modal de Configurações (super_admin-only, ver
// SettingsModal.tsx/lib/auth.tsx::isSuperAdmin) — porta de
// .settings-pane[data-pane="groups"] (index.html) + renderGroupList/
// filterGroupList/deleteGroupConfirm (js/groups-admin.js) — fatia 6.
//
// A busca (#groupSearchInput) é client-side (filtra a lista já carregada
// por nome, case-insensitive) — mesmo padrão de _gaAllGroups/
// filterGroupList() do original, aqui como estado local (allGroups) +
// derivação (filtered) em vez de reconstruir o DOM a cada tecla. Mesma
// observação do original pra célula "Members": junta TODOS os usernames
// com ", " — a elipse (.audit-log-table td já tem text-overflow:ellipsis)
// é quem corta visualmente, não um slice() em JS.
// ════════════════════════════════════════════════
import { Fragment, useEffect, useState } from 'react';
import { useConfirm } from '../../lib/useConfirm';
import { ApiError } from '../../lib/api';
import { deleteGroup, listGroups, type Group } from '../../lib/groups';
import { NewGroupModal } from './NewGroupModal';
import { Avatar, AvatarStack } from '../Avatar';
import { ManageGroupPanel } from './ManageGroupPanel';

export function GroupsPane() {
  const confirm = useConfirm();
  const [allGroups, setAllGroups] = useState<Group[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [manageGroupId, setManageGroupId] = useState<number | null>(null);

  async function load() {
    setLoadError('');
    try {
      setAllGroups(await listGroups());
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : 'Failed to load groups. Please try again.');
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function deleteGroupConfirm(group: Group) {
    const ok = await confirm(
      `Delete the group "${group.name}"? Its members immediately stop seeing each other's shared commands/folders through it. This cannot be undone.`,
      { danger: true }
    );
    if (!ok) return;
    try {
      await deleteGroup(group.id);
      await load();
    } catch (e) {
      alert(e instanceof ApiError ? e.message : 'Failed to delete group.');
    }
  }

  function handleGroupChanged(updated: Group) {
    setAllGroups(curr => (curr ? curr.map(g => (g.id === updated.id ? updated : g)) : curr));
  }

  const term = search.trim().toLowerCase();
  const filtered = allGroups ? (term ? allGroups.filter(g => g.name.toLowerCase().includes(term)) : allGroups) : null;

  return (
    <div className="settings-pane" data-pane="groups">
      <div className="set-group">
        <span className="set-label">Groups</span>
        <span className="set-hint">
          Everyone in a group can see everyone else's commands and folders in that same group — on top of (not instead of) the individual
          sharing in "User account". A user can belong to more than one group.
        </span>
        <div className="settings-action-row">
          <button type="button" className="btn btn-primary" onClick={() => setNewGroupOpen(true)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="8" cy="8" r="3" />
              <circle cx="16" cy="8" r="3" />
              <path d="M2 19c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" />
              <path d="M12 19c0-2.8 2.2-5.5 5-5.5 2.8 0 5 2.7 5 5.5" />
            </svg>
            <span>New group</span>
          </button>
        </div>
        <input type="text" className="set-input" placeholder="Search by group name…" value={search} onChange={ev => setSearch(ev.target.value)} />
        <div className="audit-log-wrap people-table">
          <table className="audit-log-table">
            <thead>
              <tr>
                <th>Group</th>
                <th>Members</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {loadError ? (
                <tr>
                  <td colSpan={3} className="audit-log-loading">
                    {loadError}
                  </td>
                </tr>
              ) : filtered === null ? (
                <tr>
                  <td colSpan={3} className="audit-log-loading">
                    Loading…
                  </td>
                </tr>
              ) : (
                filtered.map(g => {
                  const expanded = manageGroupId === g.id;
                  return (
                    <Fragment key={g.id}>
                      <tr className={`group-row${expanded ? ' is-open' : ''}`} onClick={() => setManageGroupId(expanded ? null : g.id)} aria-expanded={expanded}>
                        <td>
                          <div className="person">
                            <svg className="row-caret" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M9 6l6 6-6 6" />
                            </svg>
                            <Avatar name={g.name} size={28} />
                            <span className="person-name">{g.name}</span>
                          </div>
                        </td>
                        <td>
                          {g.members.length ? (
                            <div className="group-members">
                              <AvatarStack names={g.members} />
                              <span className="person-sub">{g.members.length === 1 ? '1 member' : `${g.members.length} members`}</span>
                            </div>
                          ) : (
                            <span className="person-sub">No members</span>
                          )}
                        </td>
                        <td>
                          <div className="row-actions">
                            <button
                              type="button"
                              className="sec-folder-btn"
                              title="Delete group"
                              onClick={ev => {
                                ev.stopPropagation();
                                deleteGroupConfirm(g);
                              }}
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M4 7h16" />
                                <path d="M10 11v6M14 11v6" />
                                <path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
                                <path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
                              </svg>
                            </button>
                          </div>
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="group-detail-row">
                          <td colSpan={3}>
                            <ManageGroupPanel group={g} onClose={() => setManageGroupId(null)} onChanged={handleGroupChanged} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
          {filtered !== null && !loadError && filtered.length === 0 && (
            <div className="audit-log-empty">{term ? 'No groups match your search.' : 'No groups yet.'}</div>
          )}
        </div>
      </div>
      {newGroupOpen && (
        <NewGroupModal
          onClose={() => setNewGroupOpen(false)}
          onCreated={group => setAllGroups(curr => (curr ? [...curr, group].sort((a, b) => a.name.localeCompare(b.name)) : [group]))}
        />
      )}
    </div>
  );
}
