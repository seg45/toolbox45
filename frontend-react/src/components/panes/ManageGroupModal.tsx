// ════════════════════════════════════════════════
// "Manage group" (#manageGroupOverlay no original) — porta de
// openManageGroupModal/closeManageGroupModal/_gaRenderMemberTable/
// _gaLoadMemberAddOptions/submitRenameGroup/submitAddGroupMember/
// removeGroupMemberConfirm (js/groups-admin.js) — fatia 6.
//
// A coluna da tabela de membros se chama "Email" mas o valor é `username`
// (neste app, username É o e-mail de login — ver comentário em
// js/groups-admin.js/server-py/app/routers/users.py: "users.username
// REAL"). O <select> de "add member" é populado por GET /api/users
// (listUsersForGroupPicker) TODA VEZ que este modal abre e de novo após
// cada add/remove — NÃO cacheado de lugar nenhum, mesma decisão deliberada
// do original.
// ════════════════════════════════════════════════
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useConfirm } from '../../lib/useConfirm';
import { ApiError } from '../../lib/api';
import { addGroupMember, listUsersForGroupPicker, removeGroupMember, renameGroup, type Group } from '../../lib/groups';

export function ManageGroupModal({ group, onClose, onChanged }: { group: Group; onClose: () => void; onChanged: (updated: Group) => void }) {
  const confirm = useConfirm();

  const [name, setName] = useState(group.name);
  const [savedName, setSavedName] = useState(group.name);
  const [renameStatus, setRenameStatus] = useState('');

  const [members, setMembers] = useState<string[]>(group.members.slice());
  const [addStatus, setAddStatus] = useState('');
  const [selectValue, setSelectValue] = useState('');
  const [options, setOptions] = useState<string[] | null>(null); // null = loading
  const [optionsFailed, setOptionsFailed] = useState(false);

  async function loadOptions(currentMembers: string[]) {
    setOptions(null);
    setOptionsFailed(false);
    try {
      const users = await listUsersForGroupPicker();
      const memberSet = new Set(currentMembers);
      const available = users
        .map(u => u.username)
        .filter(u => !memberSet.has(u))
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
      setOptions(available);
      setSelectValue(available[0] || '');
    } catch {
      setOptionsFailed(true);
      setOptions([]);
    }
  }

  useEffect(() => {
    loadOptions(members);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group.id]);

  async function submitRename() {
    const trimmed = name.trim();
    if (!trimmed) {
      setRenameStatus('Name is required.');
      return;
    }
    try {
      const res = await renameGroup(group.id, trimmed);
      setRenameStatus('Saved.');
      setSavedName(res.name);
      onChanged({ ...group, name: res.name, members });
    } catch (e) {
      setRenameStatus(e instanceof ApiError ? e.message : 'Failed to rename group.');
    }
  }

  async function submitAddMember() {
    if (!selectValue) {
      setAddStatus('Choose a user to add.');
      return;
    }
    try {
      const res = await addGroupMember(group.id, selectValue);
      setMembers(res.members);
      setAddStatus('');
      await loadOptions(res.members);
      onChanged({ ...group, name: savedName, members: res.members });
    } catch (e) {
      setAddStatus(e instanceof ApiError ? e.message : 'Failed to add member.');
    }
  }

  async function removeMemberConfirm(username: string) {
    const ok = await confirm(`Remove "${username}" from this group? They immediately stop sharing commands/folders with the other members through it.`, {
      danger: true,
    });
    if (!ok) return;
    try {
      await removeGroupMember(group.id, username);
      const nextMembers = members.filter(u => u !== username);
      setMembers(nextMembers);
      await loadOptions(nextMembers);
      onChanged({ ...group, name: savedName, members: nextMembers });
    } catch (e) {
      alert(e instanceof ApiError ? e.message : 'Failed to remove member.');
    }
  }

  const sortedMembers = members.slice().sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  return createPortal(
    <div
      className="modal-overlay show"
      onClick={ev => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <div className="modal-box modal-wide">
        <div className="modal-head">
          <span className="modal-title">Manage group — {savedName}</span>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="set-group">
            <span className="set-label">Name</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input
                className="set-input"
                type="text"
                autoComplete="off"
                maxLength={120}
                style={{ maxWidth: 280 }}
                value={name}
                onChange={ev => setName(ev.target.value)}
                onKeyDown={ev => {
                  if (ev.key === 'Enter') submitRename();
                }}
              />
              <button type="button" className="btn btn-sm" onClick={submitRename}>
                Rename
              </button>
              <span className="set-hint">{renameStatus}</span>
            </div>
          </div>
          <div className="set-group">
            <span className="set-label">Members</span>
            <span className="set-hint">
              Everyone listed here can see everyone else's commands and folders — adding someone takes effect immediately, no acceptance flow.
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <select className="set-input" style={{ maxWidth: 240 }} value={selectValue} onChange={ev => setSelectValue(ev.target.value)}>
                {options === null ? (
                  <option value="">Loading…</option>
                ) : optionsFailed ? (
                  <option value="">Failed to load users</option>
                ) : options.length === 0 ? (
                  <option value="">No other users available</option>
                ) : (
                  options.map(u => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))
                )}
              </select>
              <button type="button" className="btn btn-sm" onClick={submitAddMember}>
                Add member
              </button>
              <span className="set-hint">{addStatus}</span>
            </div>
            <div className="audit-log-wrap" style={{ maxHeight: '40vh' }}>
              <table className="audit-log-table">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {sortedMembers.map(u => (
                    <tr key={u}>
                      <td>{u}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button type="button" className="btn btn-sm" onClick={() => removeMemberConfirm(u)}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {sortedMembers.length === 0 && <div className="audit-log-empty">No members yet.</div>}
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <div></div>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
