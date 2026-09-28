// ════════════════════════════════════════════════
// Porta de js/logo-settings.js (_logoBoot/_logoApplyToDom/LOGO_CACHE_KEY) —
// só a parte de "aplicar o logo assim que a página carrega". O modal de
// administração (Settings -> System -> Logo) é admin-only e entra na
// fatia 8, junto com o resto de Configurações do sistema.
//
// No app original, o valor cacheado era aplicado por um <script> inline
// mutando o <img> diretamente no DOM (pra rodar ANTES do fetch, evitando o
// "flash" do logo default). Em React o equivalente idiomático é o mesmo
// efeito, só que via estado: o useState abaixo lê o cache de forma
// SÍNCRONA no inicializador (roda durante o primeiro render, antes de
// qualquer paint do navegador) — não existe um frame intermediário com o
// valor errado, exatamente como o script inline original.
// ════════════════════════════════════════════════
import { useEffect, useState } from 'react';
import { fetchLogo } from './api';

const CACHE_KEY = { light: 'cpa-logo-cache-light', dark: 'cpa-logo-cache-dark' } as const;

function readCache(theme: 'light' | 'dark'): string | null {
  try {
    return localStorage.getItem(CACHE_KEY[theme]);
  } catch {
    return null;
  }
}

function writeCache(theme: 'light' | 'dark', dataUrl: string | null): void {
  try {
    if (dataUrl) localStorage.setItem(CACHE_KEY[theme], dataUrl);
    else localStorage.removeItem(CACHE_KEY[theme]);
  } catch {
    /* localStorage indisponível — sem cache, sem problema, só volta a piscar */
  }
}

export interface LogoSrcs {
  light: string | null;
  dark: string | null;
}

export function useLogo(): LogoSrcs {
  const [light, setLight] = useState<string | null>(() => readCache('light'));
  const [dark, setDark] = useState<string | null>(() => readCache('dark'));

  useEffect(() => {
    let cancelled = false;
    fetchLogo()
      .then(data => {
        if (cancelled) return;
        const nextLight = typeof data.imageData === 'string' ? data.imageData : null;
        const nextDark = typeof data.imageDataDark === 'string' ? data.imageDataDark : null;
        setLight(nextLight);
        setDark(nextDark);
        writeCache('light', nextLight);
        writeCache('dark', nextDark);
      })
      .catch(e => {
        // eslint-disable-next-line no-console
        console.warn('Não foi possível carregar o logo customizado — usando o padrão', e);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { light, dark };
}
