// ════════════════════════════════════════════════
// CONTEXTO DE AUTENTICAÇÃO (fatia 2 — App shell) — porta de
// js/user-sync.js::initUserSync()/fetchMeWithRetry() + js/auth.js::
// updateAccountUI()/applyAdminGating(), como um Context/hook React em vez
// do padrão imperativo original (window.TB45_IS_ADMIN + esconder/mostrar
// elementos do DOM por id).
//
// A garantia "fail closed" do original (ADMIN_ONLY_SETTINGS_GROUP_IDS/
// SUPER_ADMIN_ONLY_SETTINGS_GROUP_IDS, elementos que nascem
// display:none e só aparecem depois que applyAdminGating() confirma o
// cargo) é preservada aqui pelo próprio modelo do React: `isAdmin`/
// `isSuperAdmin` começam `false` e qualquer JSX condicionado a eles
// ({isAdmin && <X/>}) simplesmente não é montado enquanto a resposta de
// /api/me não chega — não existe uma janela em que o elemento esteja no
// DOM e só escondido por CSS.
// ════════════════════════════════════════════════
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { fetchMe, logout as apiLogout, type MeResponse } from './api';

const LOGIN_FLAG_KEY = 'cpa-authenticated';

export interface AuthState {
  loading: boolean;
  // null enquanto carrega OU se /api/me falhou de vez (ver roleLabel/
  // authError abaixo pra distinguir os dois casos na UI).
  me: MeResponse | null;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  authMethod: MeResponse['authMethod'];
  roleLabel: string;
  authError: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

// Mesma retentativa do original (fetchMeWithRetry): uma tentativa extra
// após uma pequena espera, cobrindo o caso de um 502/503 transitório
// logo após um rebuild do backend.
async function fetchMeWithRetry(): Promise<MeResponse> {
  const MAX_ATTEMPTS = 2;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fetchMe();
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, 1200));
    }
  }
  throw lastErr;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [authError, setAuthError] = useState(false);
  // Só mostra a tela de "Loading…" (ver AppShell.tsx) na PRIMEIRA carga —
  // uma atualização depois de já autenticado (ex.: AccountPane chamando
  // refresh() após uma ação na conta) não pode desmontar o app inteiro
  // (incluindo o próprio modal de Configurações aberto, que fecharia e
  // perderia o estado local do formulário no meio do caminho). Bug
  // encontrado durante os testes desta fatia — por isso um ref (não
  // estado) marcando se a primeira carga já terminou, em vez de derivar
  // isso de `me`, que mudaria a identidade de refresh() e causaria um
  // loop no useEffect de carga inicial abaixo.
  const hasLoadedOnceRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!hasLoadedOnceRef.current) setLoading(true);
    setAuthError(false);
    try {
      const data = await fetchMeWithRetry();
      setMe(data);
    } catch (e: any) {
      // Sessão inválida/expirada (401) apesar da marca 'cpa-authenticated'
      // ainda estar no localStorage — mesmo tratamento do gate de
      // index.html/fetchMeWithRetry original: limpa a marca e manda de
      // volta pro login, sem gastar a UI num estado de erro.
      if (e && e.status === 401) {
        try { localStorage.removeItem(LOGIN_FLAG_KEY); } catch { /* ver comentário equivalente no gate */ }
        location.replace('login.html');
        return;
      }
      console.warn('Não foi possível identificar o usuário atual', e);
      setMe(null);
      setAuthError(true);
    } finally {
      hasLoadedOnceRef.current = true;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    await apiLogout();
    try { localStorage.removeItem(LOGIN_FLAG_KEY); } catch { /* ver comentário no gate */ }
    location.href = 'login.html';
  }, []);

  const isAdmin = !!me?.isAdmin;
  const isSuperAdmin = !!me?.isSuperAdmin;
  const roleLabel = me ? (me.isSuperAdmin ? 'Super Admin' : me.isAdmin ? 'Admin' : 'User') : '';

  const value: AuthState = {
    loading,
    me,
    isAdmin,
    isSuperAdmin,
    authMethod: me?.authMethod,
    roleLabel,
    authError,
    refresh,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth() precisa estar dentro de <AuthProvider>');
  return ctx;
}

// Rótulo do método de login — mesmo mapa do original (updateAccountUI).
const METHOD_LABELS: Record<string, string> = {
  local: 'local account',
  api_key: 'API key',
  google: 'Google account',
  microsoft: 'Microsoft account',
  anonymous: 'unidentified session',
};
export function authMethodLabel(method?: string): string {
  return METHOD_LABELS[method || 'local'] || 'local account';
}
