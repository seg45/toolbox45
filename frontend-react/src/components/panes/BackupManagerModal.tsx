// ════════════════════════════════════════════════
// "Database backup" (Settings → Database → Backup & Restore) — porta de
// js/backup.js + #backupManagerOverlay (index.html). Cobre backup manual,
// agendamento diário/semanal/mensal e a lista de backups existentes com
// baixar/restaurar. Restaurar substitui o banco via pg_restore no servidor;
// a página só recarrega (window.location.reload) para mostrar os dados.
//
// Mensagens de falha são textos FIXOS (como no original) — nunca a mensagem
// do servidor. alert()/location.reload() usados direto, como no original.
// ════════════════════════════════════════════════
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useConfirm } from '../../lib/useConfirm';
import {
  backupDownloadUrl,
  createBackup,
  fetchBackups,
  fetchBackupSchedule,
  formatBackupDate,
  formatBackupSize,
  restoreBackup,
  saveBackupSchedule,
  type BackupFile,
  type BackupFrequency,
  type BackupSchedule,
} from '../../lib/backup';

const DEFAULT_SCHEDULE: BackupSchedule = { enabled: false, frequency: 'daily', weeklyDays: [], monthlyDay: 1, time: '02:00' };

const FREQ_LABELS: Record<BackupFrequency, string> = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };
const FREQ_ORDER: BackupFrequency[] = ['daily', 'weekly', 'monthly'];
const WEEK_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

type ListState = 'loading' | 'error' | 'ready';

export function BackupManagerModal({ onClose }: { onClose: () => void }) {
  const confirm = useConfirm();

  // ── Lista ──
  const [listState, setListState] = useState<ListState>('loading');
  const [rows, setRows] = useState<BackupFile[]>([]);

  // ── Backup manual ──
  const [nowBusy, setNowBusy] = useState(false);
  const [nowStatus, setNowStatus] = useState('');

  // ── Agendamento ── (monthlyDay/time dos inputs ficam como texto, lidos só
  // no Save — mesmo papel dos <input> lidos via DOM em saveBackupSchedule())
  const [schedule, setSchedule] = useState<BackupSchedule>(DEFAULT_SCHEDULE);
  const [monthlyInput, setMonthlyInput] = useState(String(DEFAULT_SCHEDULE.monthlyDay));
  const [timeInput, setTimeInput] = useState(DEFAULT_SCHEDULE.time);
  const [schedStatus, setSchedStatus] = useState('');
  const [freqOpen, setFreqOpen] = useState(false);
  const freqRef = useRef<HTMLDivElement>(null);

  // renderBackupList()
  async function loadList() {
    setListState('loading');
    try {
      const data = await fetchBackups();
      setRows(data);
      setListState('ready');
    } catch {
      setListState('error');
    }
  }

  // _bkApplyScheduleUI(): reaplica o estado nos inputs de texto.
  function applyInputsFrom(s: BackupSchedule) {
    setMonthlyInput(String(s.monthlyDay));
    setTimeInput(s.time);
  }

  // loadBackupSchedule()
  async function loadSchedule() {
    let next = DEFAULT_SCHEDULE;
    try {
      const data = await fetchBackupSchedule();
      next = {
        enabled: !!data.enabled,
        frequency: data.frequency || 'daily',
        weeklyDays: Array.isArray(data.weeklyDays) ? data.weeklyDays : [],
        monthlyDay: data.monthlyDay || 1,
        time: data.time || '02:00',
      };
      setSchedule(next);
    } catch (err) {
      console.error('Failed to load backup schedule', err);
    }
    // Em caso de falha, o original reaplica o estado atual (padrão).
    applyInputsFrom(next);
  }

  useEffect(() => {
    loadList();
    loadSchedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // Fecha o dropdown de frequência ao clicar fora (mesmo mecanismo de
  // AddFolderDropdown em FolderSection.tsx).
  useEffect(() => {
    if (!freqOpen) return;
    function onDocClick(ev: MouseEvent) {
      if (freqRef.current && !freqRef.current.contains(ev.target as Node)) setFreqOpen(false);
    }
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [freqOpen]);

  // backupNow()
  async function handleBackupNow() {
    setNowBusy(true);
    setNowStatus('Creating backup…');
    try {
      const data = await createBackup();
      setNowStatus(`Backup created: ${data.filename}`);
      loadList();
    } catch (err) {
      setNowStatus('Backup failed. Please try again.');
      console.error('Backup now failed', err);
    } finally {
      setNowBusy(false);
    }
  }

  // restoreBackup(filename)
  async function handleRestore(filename: string) {
    const ok = await confirm(
      `Restore "${filename}"? This replaces the current database with this backup's contents. A safety copy of the current database is taken automatically first.`,
      { danger: true }
    );
    if (!ok) return;
    try {
      const data = await restoreBackup(filename);
      window.alert(data.message || 'Restore complete.');
      window.location.reload();
    } catch (err) {
      window.alert('Restore failed. Please try again.');
      console.error('Restore failed', err);
    }
  }

  // toggleBackupScheduleEnabled() — o original reaplica TODO o estado na UI
  // (_bkApplyScheduleUI), inclusive os inputs de dia do mês/hora, então
  // edições ainda não salvas nesses dois campos voltam ao último estado.
  function toggleEnabled() {
    const next = { ...schedule, enabled: !schedule.enabled };
    setSchedule(next);
    applyInputsFrom(next);
  }

  // setBackupFrequency(freq)
  function setFrequency(freq: BackupFrequency) {
    setSchedule(s => ({ ...s, frequency: freq }));
    setFreqOpen(o => !o);
  }

  // toggleBackupWeeklyDay(day) — ordem de clique (push/remove), sem ordenar.
  function toggleWeeklyDay(day: number) {
    setSchedule(s => ({
      ...s,
      weeklyDays: s.weeklyDays.includes(day) ? s.weeklyDays.filter(d => d !== day) : [...s.weeklyDays, day],
    }));
  }

  // saveBackupSchedule()
  async function handleSaveSchedule() {
    const next: BackupSchedule = {
      ...schedule,
      monthlyDay: Math.min(31, Math.max(1, parseInt(monthlyInput, 10) || 1)),
      time: timeInput || '02:00',
    };
    setSchedule(next);
    setSchedStatus('Saving…');
    try {
      await saveBackupSchedule(next);
      setSchedStatus('Schedule saved.');
    } catch (err) {
      setSchedStatus('Failed to save. Please try again.');
      console.error('Failed to save backup schedule', err);
    }
  }

  const freq = schedule.frequency;

  return createPortal(
    <div
      className="modal-overlay show"
      onClick={ev => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <div className="modal-box modal-wide">
        <div className="modal-head">
          <span className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M2 4.3c0-1.1 2.7-1.9 6-1.9s6 .8 6 1.9-2.7 1.9-6 1.9-6-.8-6-1.9z" stroke="currentColor" strokeWidth="1.3" />
              <path
                d="M2 4.3v3.4c0 1.1 2.7 1.9 6 1.9s6-.8 6-1.9V4.3M2 7.7v3.4c0 1.1 2.7 1.9 6 1.9s6-.8 6-1.9V7.7"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              />
            </svg>
            <span>Database backup</span>
          </span>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="set-group">
            <span className="set-label">Manual backup</span>
            <span className="set-hint">
              Creates a full, consistent snapshot of the database right now, saved to the "backup" folder next to the database file.
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button type="button" className="btn btn-primary" id="backupNowBtn" disabled={nowBusy} onClick={handleBackupNow}>
                🗄️ Backup now
              </button>
              <span className="set-hint" id="backupNowStatus">
                {nowStatus}
              </span>
            </div>
          </div>

          <div className="set-group">
            <span className="set-label">Scheduled backup</span>
            <div className={`sb-toggle${schedule.enabled ? ' on' : ''}`} id="backupScheduleToggle" onClick={toggleEnabled}>
              <div className="tog-track">
                <div className="tog-knob"></div>
              </div>
              <span>Enable automatic backup</span>
            </div>
            <div
              id="backupScheduleOptions"
              style={{ opacity: schedule.enabled ? '1' : '.45', pointerEvents: schedule.enabled ? undefined : 'none' }}
            >
              <div className="set-group set-group-row">
                <span className="set-label">Frequency</span>
                <div className={`dd${freqOpen ? ' open' : ''}`} id="backupFreqDD" ref={freqRef}>
                  <button
                    type="button"
                    className="dd-btn"
                    id="backupFreqDDBtn"
                    onClick={ev => {
                      ev.stopPropagation();
                      setFreqOpen(o => !o);
                    }}
                  >
                    <span className="dd-label" id="backupFreqLabel">
                      {FREQ_LABELS[freq] || 'Daily'}
                    </span>
                    <span className="dd-arrow">▾</span>
                  </button>
                  <div className="dd-panel seg" id="backupFreq">
                    {FREQ_ORDER.map(f => (
                      <button
                        key={f}
                        type="button"
                        className={`seg-btn${freq === f ? ' on' : ''}`}
                        data-val={f}
                        onClick={ev => {
                          ev.stopPropagation();
                          setFrequency(f);
                        }}
                      >
                        {FREQ_LABELS[f]}
                      </button>
                    ))}
                    <div className="dd-panel-foot">
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={ev => {
                          ev.stopPropagation();
                          setFreqOpen(o => !o);
                        }}
                      >
                        Close
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              <div className="set-group set-group-row" id="backupWeeklyRow" style={{ display: freq === 'weekly' ? '' : 'none' }}>
                <span className="set-label">Days of the week</span>
                <div className="seg" id="backupWeeklyDays">
                  {WEEK_DAYS.map((label, day) => (
                    <button
                      key={day}
                      type="button"
                      className={`seg-btn${schedule.weeklyDays.includes(day) ? ' on' : ''}`}
                      data-day={day}
                      onClick={() => toggleWeeklyDay(day)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="set-group set-group-row" id="backupMonthlyRow" style={{ display: freq === 'monthly' ? '' : 'none' }}>
                <span className="set-label">Day of the month</span>
                <input
                  className="set-input"
                  type="number"
                  min={1}
                  max={31}
                  id="backupMonthlyDay"
                  style={{ maxWidth: 80 }}
                  value={monthlyInput}
                  onChange={ev => setMonthlyInput(ev.target.value)}
                />
              </div>
              <div className="set-group set-group-row">
                <span className="set-label">Time</span>
                <input
                  className="set-input"
                  type="time"
                  id="backupScheduleTime"
                  style={{ maxWidth: 120 }}
                  value={timeInput}
                  onChange={ev => setTimeInput(ev.target.value)}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button type="button" className="btn btn-primary" onClick={handleSaveSchedule}>
                  Save schedule
                </button>
                <span className="set-hint" id="backupScheduleStatus">
                  {schedStatus}
                </span>
              </div>
            </div>
          </div>

          <div className="set-group">
            <span className="set-label">Existing backups</span>
            <div className="audit-log-wrap" id="backupListWrap">
              <table className="audit-log-table">
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Date/Time</th>
                    <th>Size</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody id="backupListTbody">
                  {listState === 'loading' && (
                    <tr>
                      <td colSpan={4} className="audit-log-loading">
                        Loading…
                      </td>
                    </tr>
                  )}
                  {listState === 'error' && (
                    <tr>
                      <td colSpan={4} className="audit-log-loading">
                        Failed to load the backup list. Please try again.
                      </td>
                    </tr>
                  )}
                  {listState === 'ready' &&
                    rows.map(r => (
                      <tr key={r.filename}>
                        <td>{r.filename}</td>
                        <td>{formatBackupDate(r.createdAt)}</td>
                        <td>{formatBackupSize(r.sizeBytes)}</td>
                        <td style={{ whiteSpace: 'nowrap', display: 'flex', gap: 6 }}>
                          <a className="btn btn-sm" href={backupDownloadUrl(r.filename)} download>
                            ⬇️ Download
                          </a>
                          <button type="button" className="btn btn-sm" onClick={() => handleRestore(r.filename)}>
                            ♻️ Restore
                          </button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
              <div
                className="audit-log-empty"
                id="backupListEmpty"
                style={{ display: listState === 'ready' && rows.length === 0 ? '' : 'none' }}
              >
                No backups yet — click "Backup now" to create the first one.
              </div>
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
