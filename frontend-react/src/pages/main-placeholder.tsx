import React from 'react';
import ReactDOM from 'react-dom/client';
import '../styles/base.css';
import '../styles/theme.css';
import '../styles/components.css';

// Placeholder — o app principal de verdade (header, sidebar, comandos)
// entra na Fase 3, fatia 2 (app shell). Este componente só existe pra
// confirmar visualmente, nesta fatia, que o login redirecionou com
// sucesso pro backend Python e que a sessão foi reconhecida (GET /api/me).
function MainPlaceholder() {
  const [me, setMe] = React.useState<string>('carregando…');

  React.useEffect(() => {
    fetch('/api/me')
      .then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(data => setMe(JSON.stringify(data, null, 2)))
      .catch(err => setMe(`Falha ao confirmar sessão: ${String(err)}`));
  }, []);

  return (
    <div style={{ padding: 32, fontFamily: 'var(--sans)', color: 'var(--text)' }}>
      <h1>Toolbox45 — Fase 3, fatia 1</h1>
      <p>
        Login concluído com sucesso contra o backend Python. O app principal (header, sidebar,
        comandos) é construído na próxima fatia (Fase 3, fatia 2 — app shell).
      </p>
      <p>Resposta de <code>GET /api/me</code>:</p>
      <pre style={{ background: 'var(--surf)', padding: 12, borderRadius: 8, border: '1px solid var(--bdr)' }}>
        {me}
      </pre>
      <a href="javascript:void(0)" onClick={() => (location.href = 'login.html')}>
        ← Voltar pro login
      </a>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MainPlaceholder />
  </React.StrictMode>
);
