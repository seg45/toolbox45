// ════════════════════════════════════════════════
// SSL CERTIFICATE — modal aberto pelo botão "Manage certificate" em
// Settings → System → SSL Certificate (admin-only, ver
// ADMIN_ONLY_SETTINGS_GROUP_IDS em js/auth.js). Cobre:
//   1) Status do certificado atual (GET /api/system/ssl-certificate) —
//      subject/issuer/validade/fingerprint, com aviso se autoassinado ou
//      expirado.
//   2) Importar/substituir por um certificado próprio (POST, mesma rota) —
//      cert + key (PEM, sem senha) coladas ou carregadas de arquivo, chain
//      opcional.
//   3) Excluir o certificado customizado (DELETE, mesma rota) — servidor
//      volta a gerar um autoassinado (ensureTlsBootstrap()/
//      generateSelfSignedCert() em server/index.js).
//
// O certificado em si é servido pelo nginx do toolbox45-frontend, não por
// este backend (ver frontend/nginx.conf) — o volume toolbox45-tls é
// compartilhado entre os dois containers, e um watcher (inotifywait, ver
// frontend/docker-entrypoint.sh) dá `nginx -s reload` sempre que o backend
// escreve um novo cert.pem/key.pem, então a troca feita aqui já vale para
// HTTPS na hora, sem reiniciar nada manualmente.
// ════════════════════════════════════════════════

function _sslEscHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _sslFormatDate(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p2 = n => String(n).padStart(2, '0');
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function openSslCertificateModal() {
  const overlay = document.getElementById('sslCertificateOverlay');
  if (!overlay) return;
  overlay.classList.add('show');
  ['sslCertPemInput', 'sslKeyPemInput', 'sslChainPemInput'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const status = document.getElementById('sslSaveStatus');
  if (status) status.textContent = '';
  loadSslCertificateStatus();
}

function closeSslCertificateModal() {
  const overlay = document.getElementById('sslCertificateOverlay');
  if (overlay) overlay.classList.remove('show');
}

// Click-outside-to-close + Escape, mesmo padrão de backup.js/audit-log.js.
document.addEventListener('DOMContentLoaded', () => {
  const overlay = document.getElementById('sslCertificateOverlay');
  if (overlay) overlay.addEventListener('click', ev => { if (ev.target.id === 'sslCertificateOverlay') overlay.classList.remove('show'); });
});
document.addEventListener('keydown', ev => {
  if (ev.key !== 'Escape') return;
  const overlay = document.getElementById('sslCertificateOverlay');
  if (overlay) overlay.classList.remove('show');
});

// Lê o arquivo escolhido num <input type="file"> e joga o texto no
// <textarea> alvo — usado pelos 3 botões "📄 Upload file" (cert/key/chain).
// Aceita qualquer extensão de texto (.pem/.crt/.key/...) — o conteúdo é só
// texto PEM, não binário.
function _sslReadFileIntoTextarea(fileInput, textareaId) {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const ta = document.getElementById(textareaId);
    if (ta) ta.value = String(reader.result || '').trim();
  };
  reader.onerror = () => alert('Could not read the selected file.');
  reader.readAsText(file);
  fileInput.value = ''; // permite selecionar o mesmo arquivo de novo depois
}

function _sslRenderInfo(info) {
  const el = document.getElementById('sslCertInfo');
  if (!el) return;
  const badges = [];
  if (info.isSelfSigned) badges.push('<span class="cat-protected-badge" style="background:var(--surf3,rgba(128,128,128,.2));color:var(--dim);">self-signed</span>');
  if (info.isExpired) badges.push('<span class="cat-protected-badge" style="background:rgba(229,72,77,.15);color:var(--danger,#e5484d);">expired</span>');
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
      <strong>${_sslEscHtml(info.subject || '—')}</strong>${badges.join(' ')}
    </div>
    <div style="color:var(--muted);">Issuer: ${_sslEscHtml(info.issuer || '—')}</div>
    <div style="color:var(--muted);">Valid: ${_sslEscHtml(_sslFormatDate(info.validFrom))} — ${_sslEscHtml(_sslFormatDate(info.validTo))}</div>
    <div style="color:var(--dim);font-family:var(--mono);font-size:11px;margin-top:4px;">SHA-256: ${_sslEscHtml(info.fingerprint256 || '—')}</div>
  `;
}

async function loadSslCertificateStatus() {
  const el = document.getElementById('sslCertInfo');
  if (el) el.textContent = 'Loading…';
  try {
    const res = await fetch('/api/system/ssl-certificate');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = await res.json();
    _sslRenderInfo(info);
  } catch (err) {
    if (el) el.textContent = 'Failed to load certificate status. Please try again.';
    console.error('Failed to load SSL certificate status', err);
  }
}

async function saveSslCertificate() {
  const cert = (document.getElementById('sslCertPemInput').value || '').trim();
  const key = (document.getElementById('sslKeyPemInput').value || '').trim();
  const chain = (document.getElementById('sslChainPemInput').value || '').trim();
  const btn = document.getElementById('sslSaveBtn');
  const status = document.getElementById('sslSaveStatus');
  if (!cert || !key) {
    if (status) status.textContent = 'Paste (or upload) both the certificate and the private key.';
    return;
  }
  if (btn) btn.disabled = true;
  if (status) status.textContent = 'Saving…';
  try {
    const res = await fetch('/api/system/ssl-certificate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cert, key, chain: chain || undefined }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
    if (status) status.textContent = 'Certificate saved. HTTPS will pick it up automatically within a few seconds.';
    ['sslCertPemInput', 'sslKeyPemInput', 'sslChainPemInput'].forEach(id => {
      const ta = document.getElementById(id);
      if (ta) ta.value = '';
    });
    _sslRenderInfo(data);
  } catch (err) {
    if (status) status.textContent = err.message || 'Failed to save the certificate. Please try again.';
    console.error('Failed to save SSL certificate', err);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function deleteSslCertificate() {
  openConfirmModal(
    'Remove the custom certificate and revert to a self-signed one? Browsers will show a trust warning again until a new certificate is imported.',
    { danger: true }
  ).then(async ok => {
    if (!ok) return;
    try {
      const res = await fetch('/api/system/ssl-certificate', { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      _sslRenderInfo(data);
      const status = document.getElementById('sslSaveStatus');
      if (status) status.textContent = 'Reverted to a self-signed certificate.';
    } catch (err) {
      alert('Failed to remove the certificate. Please try again.');
      console.error('Failed to delete SSL certificate', err);
    }
  });
}
