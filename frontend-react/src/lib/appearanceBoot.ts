// ════════════════════════════════════════════════
// Porta de js/appearance-settings.js::_appearanceBoot() — só o ramo
// "login.html" (a página de login SEMPRE reflete o default do admin,
// nunca uma preferência pessoal — ver comentário completo no arquivo
// original). O ramo "index.html" (que só corrige navegadores sem
// preferência PESSOAL salva) entra na fatia 2, junto com o resto do app
// shell — não se aplica aqui.
//
// O boot inline em login.html (ver <head>) já aplicou uma cópia local
// (cache) de tema/cor ANTES do primeiro paint, pra nunca "flashar" o
// valor errado. Esta função corrige esse valor com a resposta REAL do
// servidor assim que ela chega (pode ser mais nova que o cache, ex.: um
// super_admin acabou de mudar o default agora mesmo) — e atualiza o cache
// pra próxima visita.
// ════════════════════════════════════════════════
import { fetchAppearance } from './api';
import { applyAccentColor, applyTheme, resolveAccentForTheme } from './theme';

const ORG_THEME_KEY = 'cpa-org-theme';
const ORG_ACCENT_KEY = 'cpa-org-accent';

export async function bootLoginAppearance(): Promise<void> {
  let theme: 'light' | 'dark';
  let accentColor: string;
  try {
    const data = await fetchAppearance();
    theme = data.theme === 'dark' ? 'dark' : 'light';
    accentColor = typeof data.accentColor === 'string' && data.accentColor ? data.accentColor : 'teal';
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('Não foi possível carregar o tema/cor padrão do admin', e);
    return; // sem resposta do servidor, não mexe no que o boot inline já aplicou
  }
  try {
    localStorage.setItem(ORG_THEME_KEY, theme);
    localStorage.setItem(ORG_ACCENT_KEY, accentColor);
  } catch {
    /* localStorage indisponível — sem cache, sem problema, só corrige na próxima visita */
  }
  applyTheme(theme);
  applyAccentColor(resolveAccentForTheme(theme, accentColor));
}
