// ═════════════════════════════════════════════════
// LINKS — dropdown "Links" no header, ao lado do IP Calc (#linksDD/
// #linksDDPanel em index.html). Pedido do usuário: "crie ao lado do IP
// Calc uma estrutura igual dos favoritos dos browsers, onde o usuário
// pode inserir links e nomear". Puramente PESSOAL — cada usuário só vê/
// gerencia os PRÓPRIOS links, sem conceito de compartilhamento/admin
// aqui (diferente de comandos/pastas), igual a um favoritos de
// navegador de verdade — ver `links` em server/schema.sql e /api/links
// em server/index.js (sempre escopado por getCurrentUsername(req), sem
// exceção nem para admin).
// ═════════════════════════════════════════════════

function _lkEscHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// Mesma necessidade de escape em duas camadas (string JS dentro de
// onclick="...('VALOR')" + atributo HTML) já usada em outros arquivos
// admin (ex.: _gaEscJsAttr em js/groups-admin.js) — ver o comentário
// completo lá (contas legadas "DOMINIO\usuario" quebrando em \r se a
// barra invertida não for escapada primeiro).
function _lkEscJsAttr(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Cache da última lista carregada — o dropdown inteiro é reconstruído a
// partir daqui a cada create/update/delete, sem round-trip extra à API.
let _lkAllLinks = [];
// Só carrega uma vez (na primeira vez que o dropdown "Links" abre) — ver
// loadLinksIfNeeded(), chamado no onclick do botão em index.html — em vez
// de no carregamento da página, já que muita gente pode nunca usar isso.
let _lkLoaded = false;
// null = modal em modo "criar" (openLinkEditor('create')); um id = modo
// "editar" esse link (openLinkEditor('edit', id)) — mesmo padrão de
// _gaCurrentGroupId em js/groups-admin.js.
let _lkEditingId = null;

function openLinkUrl(url) {
  closeAllDropdowns();
  window.open(url, '_blank', 'noopener,noreferrer');
}

function _lkRenderRows() {
  const list = document.getElementById('linksDDList');
  const empty = document.getElementById('linksDDEmpty');
  if (!list) return;
  if (!_lkAllLinks.length) {
    list.innerHTML = '';
    if (empty) empty.style.display = '';
    return;
  }
  if (empty) empty.style.display = 'none';
  list.innerHTML = _lkAllLinks.map(l => {
    const urlAttr = _lkEscJsAttr(l.url);
    const nameAttr = _lkEscJsAttr(l.name);
    return `
    <div class="sb-row lk-row" onclick="openLinkUrl('${urlAttr}')" title="${_lkEscHtml(l.url)}">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
      <span class="lk-row-name">${_lkEscHtml(l.name)}</span>
      <span class="lk-row-actions">
        <button type="button" class="sec-folder-btn" onclick="event.stopPropagation(); openLinkEditor('edit', ${l.id})" title="Edit">✎</button>
        <button type="button" class="sec-folder-btn" onclick="event.stopPropagation(); deleteLinkConfirm(${l.id}, '${nameAttr}')" title="Delete">✕</button>
      </span>
    </div>`;
  }).join('');
}

async function loadLinksIfNeeded() {
  if (_lkLoaded) return;
  // Marca ANTES de terminar — evita reentrada em cliques rápidos no botão;
  // em caso de erro, desmarca de novo pra tentar no próximo clique.
  _lkLoaded = true;
  try {
    const res = await fetch('/api/links');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    _lkAllLinks = await res.json();
    _lkRenderRows();
  } catch (e) {
    _lkLoaded = false;
    const list = document.getElementById('linksDDList');
    if (list) list.innerHTML = '<div class="set-hint" style="padding:6px 8px;">Failed to load links.</div>';
  }
}

// ── "Add/Edit link" (mesmo modal serve pros dois, ver openCommandEditor
// pra outro exemplo já existente desse padrão) ──
function openLinkEditor(mode, id) {
  closeAllDropdowns();
  _lkEditingId = mode === 'edit' ? id : null;
  const title = document.getElementById('linkEditorTitle');
  const submitBtn = document.getElementById('linkEditorSubmitBtn');
  const nameInput = document.getElementById('linkNameInput');
  const urlInput = document.getElementById('linkUrlInput');
  const err = document.getElementById('linkEditorErrorMsg');
  if (err) { err.style.display = 'none'; err.textContent = ''; }
  if (mode === 'edit') {
    const link = _lkAllLinks.find(l => l.id === id);
    if (title) title.textContent = 'Edit link';
    if (submitBtn) submitBtn.textContent = 'Save';
    if (nameInput) nameInput.value = link ? link.name : '';
    if (urlInput) urlInput.value = link ? link.url : '';
  } else {
    if (title) title.textContent = 'Add link';
    if (submitBtn) submitBtn.textContent = 'Add';
    if (nameInput) nameInput.value = '';
    if (urlInput) urlInput.value = '';
  }
  const overlay = document.getElementById('linkEditorOverlay');
  if (overlay) overlay.classList.add('show');
  if (nameInput) setTimeout(() => nameInput.focus(), 0);
}
function closeLinkEditor() {
  const overlay = document.getElementById('linkEditorOverlay');
  if (overlay) overlay.classList.remove('show');
  _lkEditingId = null;
}
async function submitLinkEditor() {
  const name = ((document.getElementById('linkNameInput') || {}).value || '').trim();
  const url = ((document.getElementById('linkUrlInput') || {}).value || '').trim();
  const err = document.getElementById('linkEditorErrorMsg');
  if (!name || !url) {
    if (err) { err.textContent = 'Name and URL are required.'; err.style.display = ''; }
    return;
  }
  const isEdit = _lkEditingId != null;
  try {
    const res = await fetch(isEdit ? `/api/links/${_lkEditingId}` : '/api/links', {
      method: isEdit ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, url }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || `HTTP ${res.status}`);
    }
    const saved = await res.json();
    if (isEdit) {
      const idx = _lkAllLinks.findIndex(l => l.id === _lkEditingId);
      if (idx >= 0) _lkAllLinks[idx] = saved;
    } else {
      _lkAllLinks.push(saved);
    }
    _lkRenderRows();
    closeLinkEditor();
  } catch (e) {
    if (err) { err.textContent = e.message || 'Failed to save link.'; err.style.display = ''; }
  }
}

function deleteLinkConfirm(id, name) {
  openConfirmModal(`Delete the link "${name}"?`, { danger: true })
    .then(async ok => {
      if (!ok) return;
      try {
        const res = await fetch(`/api/links/${id}`, { method: 'DELETE' });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.message || `HTTP ${res.status}`);
        }
        _lkAllLinks = _lkAllLinks.filter(l => l.id !== id);
        _lkRenderRows();
      } catch (e) {
        alert(e.message || 'Failed to delete link.');
      }
    });
}

document.addEventListener('DOMContentLoaded', () => {
  const overlay = document.getElementById('linkEditorOverlay');
  if (overlay) overlay.addEventListener('click', ev => { if (ev.target.id === 'linkEditorOverlay') closeLinkEditor(); });
});
document.addEventListener('keydown', ev => {
  if (ev.key !== 'Escape') return;
  const overlay = document.getElementById('linkEditorOverlay');
  if (overlay && overlay.classList.contains('show')) closeLinkEditor();
});
