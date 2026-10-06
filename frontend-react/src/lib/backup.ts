// ════════════════════════════════════════════════
// BACKUP & RESTORE + AUDIT LOG (Fase 3, fatia 9) — cliente de API tipado e
// helpers puros de formatação. Porta dos fetches soltos de js/backup.js e
// js/audit-log.js (rotas de server-py/app/routers/backup.py, todas
// require_admin).
//
// Diferença deliberada em relação a api.ts: o original NÃO mostra a mensagem
// do servidor nas falhas destes dois modais — só textos fixos ("Backup
// failed. Please try again." etc., ver os componentes). Por isso estas
// funções só lançam ApiError(`HTTP <status>`) em !res.ok, sem ler o corpo.
// ════════════════════════════════════════════════
import { ApiError } from './api';

export interface BackupFile {
  filename: string;
  createdAt: string;
  sizeBytes: number;
}

export type BackupFrequency = 'daily' | 'weekly' | 'monthly';

export interface BackupSchedule {
  enabled: boolean;
  frequency: BackupFrequency;
  weeklyDays: number[];
  monthlyDay: number;
  time: string;
}

export interface AuditLogRow {
  id: number;
  ts: string;
  username: string | null;
  action: string | null;
  entity_type: string | null;
  entity_id: string | number | null;
  entity_name: string | null;
  details: string | null;
  command_id: string | number | null;
  command_name: string | null;
}

export interface RestoreBackupResponse {
  ok?: boolean;
  message?: string;
}

// ── Formatação (portas de _bkFormatDate/_bkFormatSize) ────────────────

// dd/mm/aaaa hh:mm no fuso LOCAL; entrada inválida volta como veio.
export function formatBackupDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

export function formatBackupSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

// ── Backups ────────────────────────────────────────────────────────────

// GET /api/backups -> [{filename, createdAt, sizeBytes}]
export async function fetchBackups(): Promise<BackupFile[]> {
  const res = await fetch('/api/backups');
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
  return res.json();
}

// POST /api/backups (201) -> {filename}
export async function createBackup(): Promise<{ filename: string }> {
  const res = await fetch('/api/backups', { method: 'POST' });
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
  return res.json();
}

// POST /api/backups/:filename/restore -> {ok, message}
export async function restoreBackup(filename: string): Promise<RestoreBackupResponse> {
  const res = await fetch(`/api/backups/${encodeURIComponent(filename)}/restore`, { method: 'POST' });
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
  return res.json();
}

// URL do <a download> de cada linha da lista.
export function backupDownloadUrl(filename: string): string {
  return `/api/backups/${encodeURIComponent(filename)}/download`;
}

// ── Agendamento ────────────────────────────────────────────────────────

// GET /api/backup-schedule -> {enabled, frequency, weeklyDays, monthlyDay, time}
// (devolvido cru; a normalização/defaults ficam no componente, como em
// loadBackupSchedule() do original).
export async function fetchBackupSchedule(): Promise<Partial<BackupSchedule>> {
  const res = await fetch('/api/backup-schedule');
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
  return res.json();
}

// PUT /api/backup-schedule — o servidor responde 204 sem corpo.
export async function saveBackupSchedule(schedule: BackupSchedule): Promise<void> {
  const res = await fetch('/api/backup-schedule', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(schedule),
  });
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
}

// ── Audit log ──────────────────────────────────────────────────────────

// GET /api/audit-log -> últimos 30 dias, mais recente primeiro (máx. 1000).
export async function fetchAuditLog(): Promise<AuditLogRow[]> {
  const res = await fetch('/api/audit-log');
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
  return res.json();
}

// ── Access log (eventos de acesso — só super admin) ───────────────────

export interface AuthEventRow {
  id: number;
  ts: string;
  event: string;
  username: string | null;
  ip: string | null;
  user_agent: string | null;
  detail: string | null;
}

// GET /api/auth-events (super_admin) -> mais recente primeiro; `event` filtra por tipo.
export async function fetchAuthEvents(event?: string): Promise<AuthEventRow[]> {
  const qs = new URLSearchParams({ limit: '500' });
  if (event) qs.set('event', event);
  const res = await fetch(`/api/auth-events?${qs.toString()}`);
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
  return res.json();
}
