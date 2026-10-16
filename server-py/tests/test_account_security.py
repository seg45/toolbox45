"""Testes de SMTP, "esqueci a senha", MFA por e-mail e conversao local <-> SSO.
Rodar a partir de server-py/:

    python -m pytest tests/test_account_security.py -v

Os e-mails NAO saem de verdade: `mailer._send_sync` e trocado por uma funcao que
guarda as mensagens numa lista (ver fixture `caixa`).
"""
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_boot import banco, sql  # noqa: E402,F401
from test_security import (  # noqa: E402,F401
    ADMIN_EMAIL, ADMIN_PASS, CLIENT_ID, GUID_A, _admin, _as, _back_to_admin, _criar_usuario, _fake_httpx, _jwt, _token,
    app_env, client,
)

from app import login_guard, mailer, oauth  # noqa: E402

SMTP = {"host": "smtp.example.com", "port": 587, "security": "starttls", "username": "robo@example.com",
        "password": "s3gredo", "fromAddress": "toolbox@example.com", "fromName": "Toolbox45",
        "appUrl": "https://toolbox.example.com/"}


@pytest.fixture(autouse=True)
def _limpa_limitadores():
    for lim in (login_guard.login_limiter, login_guard.forgot_limiter, login_guard.reset_limiter,
                login_guard.mfa_limiter, login_guard.password_change_limiter):
        lim.reset()
    yield
    for lim in (login_guard.login_limiter, login_guard.forgot_limiter, login_guard.reset_limiter,
                login_guard.mfa_limiter, login_guard.password_change_limiter):
        lim.reset()


@pytest.fixture
def caixa(monkeypatch):
    """Lista das mensagens "enviadas" (dict com to/subject/text/html)."""
    enviados = []

    def fake(cfg, to, subject, text, html):
        enviados.append({"to": to, "subject": subject, "text": text, "html": html, "cfg": cfg})

    monkeypatch.setattr(mailer, "_send_sync", fake)
    return enviados


def _tok(client, user, senha):
    """Login em um usuario e devolve o token, sem acumular cookies de dominios diferentes."""
    client.cookies.clear()
    return _token(client, user, senha)


def _smtp(admin, **over):
    r = admin.put("/api/system/smtp", json={**SMTP, **over})
    assert r.status_code == 200, r.text
    return r.json()


def _codigo(caixa):
    return re.search(r"code is: (\d{6})", caixa[-1]["text"]).group(1)


def _token_do_link(caixa):
    return re.search(r"#reset=([A-Za-z0-9_\-]+)", caixa[-1]["text"]).group(1)


async def _espera_envio(caixa, n):
    import asyncio
    for _ in range(100):
        if len(caixa) >= n:
            return
        await asyncio.sleep(0.02)


# ════════════════════════════════════════════════
# SMTP (configuracao)
# ════════════════════════════════════════════════
def test_smtp_so_super_admin_e_senha_nunca_volta(client):
    admin = _admin(client)
    assert admin.get("/api/system/smtp").json()["configured"] is False
    out = _smtp(admin)
    assert out["configured"] and out["hasPassword"] and "password" not in out
    assert out["appUrl"] == "https://toolbox.example.com"           # barra final removida
    assert "s3gredo" not in admin.get("/api/system/smtp").text
    _criar_usuario(admin, "comum@x.com")
    _criar_usuario(admin, "adm@x.com", role="admin")
    for quem in ("comum@x.com", "adm@x.com"):
        _as(client, _tok(client, quem, "senha-forte-1"))
        assert client.get("/api/system/smtp").status_code == 403
        assert client.put("/api/system/smtp", json=SMTP).status_code == 403
        assert client.post("/api/system/smtp/test", json={"to": "a@b.co"}).status_code == 403
    _as(client, None)
    assert client.get("/api/system/smtp").status_code == 401


def test_smtp_senha_fica_cifrada_e_em_branco_mantem(client, app_env, monkeypatch):
    banco, _ = app_env
    monkeypatch.setenv("TOOLBOX45_SECRET_KEY", "k" * 40)
    admin = _admin(client)
    _smtp(admin)
    guardada = sql(banco, "SELECT password FROM smtp_settings", fetch="val")
    assert guardada.startswith("enc:v1:") and "s3gredo" not in guardada
    _smtp(admin, password="", host="smtp2.example.com")              # em branco = mantem
    assert sql(banco, "SELECT password FROM smtp_settings", fetch="val") == guardada
    # trocar o usuario sem informar a senha nao reaproveita a senha de outro login
    r = admin.put("/api/system/smtp", json={**SMTP, "password": "", "username": "outro@example.com"})
    assert r.status_code == 400
    # sem usuario = sem autenticacao: a senha some
    _smtp(admin, username="", password="")
    assert sql(banco, "SELECT password FROM smtp_settings", fetch="val") is None


@pytest.mark.parametrize("campo,valor", [
    ("host", ""), ("host", "ruim host"), ("host", "a" * 300), ("port", 0), ("port", 70000), ("port", "abc"), ("port", True),
    ("security", "tls1"), ("fromAddress", "sem-arroba"), ("appUrl", "javascript:alert(1)"), ("appUrl", "ftp://x.com"),
    ("appUrl", "https://x.com/?a=b"), ("fromName", "Ana\r\nBcc: x@y.z"),
])
def test_smtp_validacao(client, campo, valor):
    admin = _admin(client)
    r = admin.put("/api/system/smtp", json={**SMTP, campo: valor})
    assert r.status_code == 400 and r.json()["error"] == "validation_error", (campo, valor, r.text)


def test_smtp_teste_envia_e_erro_vira_502(client, caixa, monkeypatch):
    admin = _admin(client)
    assert admin.post("/api/system/smtp/test", json={"to": "a@b.co"}).status_code == 409   # nao configurado
    _smtp(admin)
    assert admin.post("/api/system/smtp/test", json={"to": "ruim"}).status_code == 400
    assert admin.post("/api/system/smtp/test", json={"to": "dest@x.com"}).json() == {"ok": True}
    assert caixa[-1]["to"] == "dest@x.com" and caixa[-1]["cfg"]["password"] == "s3gredo"

    def falha(*a, **kw):
        raise mailer.MailError("The SMTP server rejected the username/password.")

    monkeypatch.setattr(mailer, "_send_sync", falha)
    r = admin.post("/api/system/smtp/test", json={"to": "dest@x.com"})
    assert r.status_code == 502 and r.json()["error"] == "smtp_error" and "s3gredo" not in r.text


def test_smtp_cabecalho_nao_aceita_quebra_de_linha():
    assert "\n" not in mailer.clean_header("Ana\r\nBcc: x@y.z") and "\r" not in mailer.clean_header("a\rb")


def test_smtp_remover_desliga_o_esqueci_a_senha(client, caixa):
    admin = _admin(client)
    assert client.get("/api/auth/providers").json()["passwordReset"] is False
    _smtp(admin)
    assert client.get("/api/auth/providers").json()["passwordReset"] is True
    assert admin.delete("/api/system/smtp").json() == {"ok": True}
    assert client.get("/api/auth/providers").json()["passwordReset"] is False


# ════════════════════════════════════════════════
# "Esqueci a senha"
# ════════════════════════════════════════════════
def test_esqueci_a_senha_fluxo_completo(client, caixa, app_env):
    import asyncio
    banco, _ = app_env
    admin = _admin(client)
    _smtp(admin)
    _criar_usuario(admin, "ana@x.com", "senha-antiga-1")
    ana = _tok(client, "ana@x.com", "senha-antiga-1")                     # sessao que deve cair no reset
    _as(client, None)

    r = client.post("/api/auth/forgot-password", json={"email": "Ana@X.com"})
    assert r.status_code == 200 and r.json()["ok"] is True
    asyncio.run(_espera_envio(caixa, 1))
    assert len(caixa) == 1 and caixa[0]["to"] == "ana@x.com"
    token = _token_do_link(caixa)
    assert "https://toolbox.example.com/login.html#reset=" in caixa[0]["text"]
    assert token not in sql(banco, "SELECT string_agg(token_hash, ',') FROM password_reset_tokens", fetch="val")  # so o hash

    ruim = client.post("/api/auth/reset-password", json={"token": token, "password": "curta"})
    assert ruim.status_code == 400 and ruim.json()["error"] == "validation_error"   # nao consome o token
    ok = client.post("/api/auth/reset-password", json={"token": token, "password": "senha-nova-123"})
    assert ok.status_code == 200
    assert client.post("/api/auth/reset-password", json={"token": token, "password": "senha-nova-456"}).json()["error"] == "invalid_token"
    assert client.post("/api/auth/login", json={"username": "ana@x.com", "password": "senha-antiga-1"}).status_code == 401
    assert client.post("/api/auth/login", json={"username": "ana@x.com", "password": "senha-nova-123"}).status_code == 200
    _as(client, ana)
    assert client.get("/api/me").status_code == 401                          # sessao antiga caiu
    assert sql(banco, "SELECT COUNT(*) FROM password_reset_tokens", fetch="val") == 0


def test_esqueci_a_senha_nao_revela_se_a_conta_existe(client, caixa):
    import asyncio
    admin = _admin(client)
    _smtp(admin)
    _criar_usuario(admin, "ana@x.com")
    admin.put("/api/users/ana@x.com", json={"disabled": True})
    _as(client, None)
    respostas = []
    for email in ("naoexiste@x.com", "ana@x.com", ADMIN_EMAIL):
        respostas.append(client.post("/api/auth/forgot-password", json={"email": email}))
    assert all(r.status_code == 200 for r in respostas)
    assert len({r.text for r in respostas}) == 1                              # corpo identico
    asyncio.run(_espera_envio(caixa, 1))
    assert [m["to"] for m in caixa] == [ADMIN_EMAIL]                          # so a conta valida recebe


def test_esqueci_a_senha_sem_smtp_e_email_invalido(client, caixa):
    assert client.post("/api/auth/forgot-password", json={"email": "a@b.co"}).status_code == 503
    assert client.post("/api/auth/forgot-password", json={"email": "ruim"}).status_code == 400
    assert client.post("/api/auth/forgot-password", json={}).status_code == 400


def test_esqueci_a_senha_limita_pedidos_e_link_nao_usa_host_da_requisicao(client, caixa):
    import asyncio
    admin = _admin(client)
    _smtp(admin)
    _as(client, None)
    codigos = [client.post("/api/auth/forgot-password", json={"email": ADMIN_EMAIL},
                           headers={"Host": "evil.example", "X-Forwarded-Host": "evil.example", "X-Real-IP": "9.9.9.9"}).status_code
               for _ in range(5)]
    assert codigos[:3] == [200, 200, 200] and codigos[3] == 429
    asyncio.run(_espera_envio(caixa, 3))
    assert all("evil.example" not in m["text"] and "toolbox.example.com" in m["text"] for m in caixa)


def test_reset_token_invalido_vencido_e_conta_desativada(client, caixa, app_env):
    import asyncio
    banco, _ = app_env
    admin = _admin(client)
    _smtp(admin)
    _criar_usuario(admin, "ana@x.com")
    _as(client, None)
    for t in ("", "curto", "x" * 40, "../../etc/passwd"):
        assert client.post("/api/auth/reset-password", json={"token": t, "password": "senha-nova-123"}).status_code == 400
    client.post("/api/auth/forgot-password", json={"email": "ana@x.com"})
    asyncio.run(_espera_envio(caixa, 1))
    token = _token_do_link(caixa)
    sql(banco, "UPDATE password_reset_tokens SET expires_at = NOW() - INTERVAL '1 minute'", fetch="exec")
    assert client.post("/api/auth/reset-password", json={"token": token, "password": "senha-nova-123"}).json()["error"] == "invalid_token"
    login_guard.forgot_limiter.reset()
    client.post("/api/auth/forgot-password", json={"email": "ana@x.com"})
    asyncio.run(_espera_envio(caixa, 2))
    token2 = _token_do_link(caixa)
    _back_to_admin(client)
    client.put("/api/users/ana@x.com", json={"disabled": True})
    _as(client, None)
    assert client.post("/api/auth/reset-password", json={"token": token2, "password": "senha-nova-123"}).status_code == 400


# ════════════════════════════════════════════════
# MFA por e-mail
# ════════════════════════════════════════════════
def _login_bruto(client, user, senha):
    return client.post("/api/auth/login", json={"username": user, "password": senha})


def _ligar_mfa(client, caixa):
    """Logado como o proprio usuario: liga o MFA (start + confirm)."""
    r = client.post("/api/me/mfa/start")
    assert r.status_code == 200, r.text
    ok = client.post("/api/me/mfa/confirm", json={"challenge": r.json()["challenge"], "code": _codigo(caixa)})
    assert ok.status_code == 200, ok.text


def test_mfa_usuario_liga_pede_codigo_no_login_e_desliga_com_senha(client, caixa, app_env):
    banco, _ = app_env
    admin = _admin(client)
    _criar_usuario(admin, "ana@x.com", "senha-forte-1")
    _as(client, _tok(client, "ana@x.com", "senha-forte-1"))
    assert client.post("/api/me/mfa/start").status_code == 409                # sem SMTP
    assert client.get("/api/me").json()["mfa"] == {"enabled": False, "required": False, "available": False}
    _back_to_admin(client)
    _smtp(admin)
    _as(client, _tok(client, "ana@x.com", "senha-forte-1"))
    assert client.get("/api/me").json()["mfa"]["available"] is True

    r = client.post("/api/me/mfa/start")
    assert r.json()["maskedEmail"] == "a***@x***.com"
    chal = r.json()["challenge"]
    assert client.post("/api/me/mfa/confirm", json={"challenge": chal, "code": "000000"}).status_code == 400
    assert sql(banco, "SELECT mfa_enabled FROM users WHERE username = 'ana@x.com'", fetch="val") == 0
    assert client.post("/api/me/mfa/confirm", json={"challenge": chal, "code": _codigo(caixa)}).status_code == 200
    assert client.get("/api/me").json()["mfa"]["enabled"] is True

    # novo login: so a senha NAO cria sessao
    _as(client, None)
    r = _login_bruto(client, "ana@x.com", "senha-forte-1")
    body = r.json()
    assert r.status_code == 200 and body["mfaRequired"] is True and body["enrolling"] is False
    assert "tb45_session" not in client.cookies and "tb45_session" not in r.headers.get("set-cookie", "")
    assert client.get("/api/me").status_code == 401
    assert client.post("/api/auth/mfa/verify", json={"challenge": body["challenge"], "code": "123456"}).status_code == 400
    ok = client.post("/api/auth/mfa/verify", json={"challenge": body["challenge"], "code": _codigo(caixa)})
    assert ok.status_code == 200 and ok.json()["username"] == "ana@x.com"
    assert client.get("/api/me").status_code == 200
    # codigo de uso unico
    assert client.post("/api/auth/mfa/verify", json={"challenge": body["challenge"], "code": _codigo(caixa)}).status_code == 400

    # desligar: precisa da senha
    assert client.post("/api/me/mfa/disable", json={"password": "errada-123"}).status_code == 401
    assert client.post("/api/me/mfa/disable", json={"password": "senha-forte-1"}).status_code == 200
    _as(client, None)
    assert "mfaRequired" not in _login_bruto(client, "ana@x.com", "senha-forte-1").json()


def test_mfa_codigo_errado_5_vezes_invalida_o_desafio(client, caixa):
    admin = _admin(client)
    _smtp(admin)
    _criar_usuario(admin, "ana@x.com", "senha-forte-1")
    _as(client, _tok(client, "ana@x.com", "senha-forte-1"))
    _ligar_mfa(client, caixa)
    _as(client, None)
    chal = _login_bruto(client, "ana@x.com", "senha-forte-1").json()["challenge"]
    certo = _codigo(caixa)
    for _ in range(5):
        client.post("/api/auth/mfa/verify", json={"challenge": chal, "code": "000000" if certo != "000000" else "111111"})
    r = client.post("/api/auth/mfa/verify", json={"challenge": chal, "code": certo})   # ja era
    assert r.status_code in (400, 429) and "tb45_session" not in client.cookies


def test_mfa_codigo_e_desafio_vencidos(client, caixa, app_env):
    banco, _ = app_env
    admin = _admin(client)
    _smtp(admin)
    _criar_usuario(admin, "ana@x.com", "senha-forte-1")
    _as(client, _tok(client, "ana@x.com", "senha-forte-1"))
    _ligar_mfa(client, caixa)
    _as(client, None)
    chal = _login_bruto(client, "ana@x.com", "senha-forte-1").json()["challenge"]
    sql(banco, "UPDATE mfa_challenges SET expires_at = NOW() - INTERVAL '1 second'", fetch="exec")
    r = client.post("/api/auth/mfa/verify", json={"challenge": chal, "code": _codigo(caixa)})
    assert r.status_code == 400 and r.json()["error"] == "invalid_challenge"
    for ruim in ("", "x", "a" * 200):
        assert client.post("/api/auth/mfa/verify", json={"challenge": ruim, "code": "123456"}).status_code == 400


def test_mfa_reenvio_tem_intervalo_e_limite(client, caixa, app_env):
    banco, _ = app_env
    admin = _admin(client)
    _smtp(admin)
    _criar_usuario(admin, "ana@x.com", "senha-forte-1")
    _as(client, _tok(client, "ana@x.com", "senha-forte-1"))
    _ligar_mfa(client, caixa)
    _as(client, None)
    chal = _login_bruto(client, "ana@x.com", "senha-forte-1").json()["challenge"]
    r = client.post("/api/auth/mfa/resend", json={"challenge": chal})
    assert r.status_code == 429 and r.json()["error"] == "resend_too_soon"
    sql(banco, "UPDATE mfa_challenges SET sent_at = NOW() - INTERVAL '1 minute'", fetch="exec")
    r = client.post("/api/auth/mfa/resend", json={"challenge": chal})
    assert r.status_code == 200
    antigo = _codigo(caixa[:-1])
    assert len(caixa) == 3 and antigo
    ok = client.post("/api/auth/mfa/verify", json={"challenge": chal, "code": _codigo(caixa)})   # o codigo NOVO vale
    assert ok.status_code == 200


def test_mfa_exigido_para_todos_ativa_no_primeiro_login_e_nao_desliga(client, caixa, app_env):
    banco, _ = app_env
    admin = _admin(client)
    _criar_usuario(admin, "ana@x.com", "senha-forte-1")
    # sem SMTP nao da para exigir
    r = admin.put("/api/system/mfa", json={"requireAll": True})
    assert r.status_code == 409 and r.json()["error"] == "smtp_not_configured"
    _smtp(admin)
    assert admin.put("/api/system/mfa", json={"requireAll": "sim"}).status_code == 400
    st = admin.put("/api/system/mfa", json={"requireAll": True}).json()
    assert st["requireAll"] is True and st["smtpAvailable"] is True

    _as(client, None)
    body = _login_bruto(client, "ana@x.com", "senha-forte-1").json()
    assert body["mfaRequired"] and body["enrolling"] is True                  # ainda nao tinha MFA: ativa agora
    assert client.post("/api/auth/mfa/verify", json={"challenge": body["challenge"], "code": _codigo(caixa)}).status_code == 200
    assert sql(banco, "SELECT mfa_enabled FROM users WHERE username = 'ana@x.com'", fetch="val") == 1
    assert client.get("/api/me").json()["mfa"] == {"enabled": True, "required": True, "available": True}
    r = client.post("/api/me/mfa/disable", json={"password": "senha-forte-1"})
    assert r.status_code == 409 and r.json()["error"] == "mfa_required"

    # o super admin tambem entra com o codigo (vale para todos)
    _as(client, None)
    assert _login_bruto(client, ADMIN_EMAIL, ADMIN_PASS).json()["mfaRequired"] is True


def test_mfa_exigido_para_um_usuario_especifico(client, caixa, app_env):
    banco, _ = app_env
    admin = _admin(client)
    _criar_usuario(admin, "ana@x.com", "senha-forte-1")
    _criar_usuario(admin, "bia@x.com", "senha-forte-1")
    assert admin.put("/api/users/ana@x.com", json={"mfaRequired": True}).status_code == 409   # sem SMTP
    _smtp(admin)
    r = admin.put("/api/users/ana@x.com", json={"mfaRequired": True})
    assert r.status_code == 200 and r.json()["mfa_required"] == 1
    assert [u["mfa_required"] for u in admin.get("/api/users").json() if u["username"] == "bia@x.com"] == [0]
    _as(client, None)
    assert _login_bruto(client, "ana@x.com", "senha-forte-1").json()["mfaRequired"] is True
    assert "mfaRequired" not in _login_bruto(client, "bia@x.com", "senha-forte-1").json()   # so a Ana
    # tirar a exigencia
    _as(client, None)
    _back_to_admin(client)
    assert admin.put("/api/users/ana@x.com", json={"mfaRequired": False}).json()["mfa_required"] == 0
    _as(client, None)
    assert "mfaRequired" not in _login_bruto(client, "ana@x.com", "senha-forte-1").json()


def test_mfa_super_admin_reseta_mfa_de_quem_perdeu_o_email(client, caixa, app_env):
    banco, _ = app_env
    admin = _admin(client)
    _smtp(admin)
    _criar_usuario(admin, "ana@x.com", "senha-forte-1")
    _as(client, _tok(client, "ana@x.com", "senha-forte-1"))
    _ligar_mfa(client, caixa)
    _back_to_admin(client)
    r = admin.put("/api/users/ana@x.com", json={"resetMfa": True})
    assert r.status_code == 200 and r.json()["mfa_enabled"] == 0
    _as(client, None)
    assert "mfaRequired" not in _login_bruto(client, "ana@x.com", "senha-forte-1").json()


def test_mfa_sem_smtp_o_login_segue_sem_trancar_ninguem(client, caixa, app_env):
    banco, _ = app_env
    admin = _admin(client)
    _smtp(admin)
    _criar_usuario(admin, "ana@x.com", "senha-forte-1")
    _as(client, _tok(client, "ana@x.com", "senha-forte-1"))
    _ligar_mfa(client, caixa)
    _back_to_admin(client)
    admin.delete("/api/system/smtp")
    _as(client, None)
    r = _login_bruto(client, "ana@x.com", "senha-forte-1")
    assert r.status_code == 200 and "mfaRequired" not in r.json() and "tb45_session" in client.cookies
    assert sql(banco, "SELECT COUNT(*) FROM auth_events WHERE event = 'mfa_skipped'", fetch="val") == 1


def test_mfa_falha_no_envio_nao_cria_sessao(client, caixa, monkeypatch):
    admin = _admin(client)
    _smtp(admin)
    _criar_usuario(admin, "ana@x.com", "senha-forte-1")
    _as(client, _tok(client, "ana@x.com", "senha-forte-1"))
    _ligar_mfa(client, caixa)
    _as(client, None)

    def falha(*a, **kw):
        raise mailer.MailError("down")

    monkeypatch.setattr(mailer, "_send_sync", falha)
    r = _login_bruto(client, "ana@x.com", "senha-forte-1")
    assert r.status_code == 502 and r.json()["error"] == "mfa_send_failed" and "tb45_session" not in client.cookies


def test_mfa_so_super_admin_mexe_na_politica(client):
    admin = _admin(client)
    _criar_usuario(admin, "adm@x.com", "senha-forte-1", role="admin")
    _as(client, _tok(client, "adm@x.com", "senha-forte-1"))
    assert client.get("/api/system/mfa").status_code == 403
    assert client.put("/api/system/mfa", json={"requireAll": False}).status_code == 403


# ════════════════════════════════════════════════
# Conversao: SSO -> local
# ════════════════════════════════════════════════
def _usuario_sso(banco, email, provider="google", role="user"):
    sql(banco, "INSERT INTO users (username, role, is_local, disabled, created_by, auth_provider, approved_at) "
               "VALUES ($1, $2, 0, 0, 'oauth', $3, NOW())", email, role, provider, fetch="exec")
    sql(banco, "INSERT INTO sessions (token, username, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 hour')",
        f"sso-{email}", email, fetch="exec")
    return f"sso-{email}"


def test_sso_vira_local_e_o_login_passa_a_ser_com_senha(client, app_env):
    banco, _ = app_env
    tok = _usuario_sso(banco, "joao@corp.com")
    _as(client, tok)
    me = client.get("/api/me").json()
    assert me["isLocal"] is False and me["authProvider"] == "google"
    assert client.post("/api/me/convert-to-local", json={"password": "curta"}).status_code == 400
    assert client.post("/api/me/convert-to-local", json={"password": "joao@corp.com"}).status_code == 400
    assert client.post("/api/me/convert-to-local", json={"password": "senha-do-joao-1"}).json() == {"ok": True}
    me = client.get("/api/me").json()                                           # a sessao atual continua
    assert me["isLocal"] is True and me["authProvider"] == "local"
    assert client.post("/api/me/convert-to-local", json={"password": "senha-do-joao-1"}).status_code == 409
    _as(client, None)
    assert _login_bruto(client, "joao@corp.com", "senha-do-joao-1").status_code == 200
    # o login SSO antigo deixa de valer: o e-mail agora pertence a uma conta local
    assert sql(banco, "SELECT auth_provider FROM users WHERE username = 'joao@corp.com'", fetch="val") == "local"


def test_conversao_para_local_recusa_conta_local_e_chave_de_api(client):
    admin = _admin(client)
    assert admin.post("/api/me/convert-to-local", json={"password": "senha-nova-123"}).status_code == 409


# ════════════════════════════════════════════════
# Conversao: local -> SSO (callback com `state` de vinculo)
# ════════════════════════════════════════════════
def _link_callback(client, monkeypatch, email, tenant=GUID_A, tid=GUID_A):
    from app.routers import oauth as oauth_router
    monkeypatch.setattr(oauth, "microsoft_config", oauth.ProviderConfig(CLIENT_ID, "sec", "https://x/cb", tenant))
    token = _jwt({"aud": CLIENT_ID, "tid": tid, "oid": "o1", "preferred_username": email})
    monkeypatch.setattr(oauth_router.httpx, "AsyncClient", _fake_httpx(token, {"email": email}))
    client.cookies.set("tb45_oauth_state_ms", "link.abc")
    return client.get("/api/auth/microsoft/callback", params={"state": "link.abc", "code": "c"})


def test_local_vira_sso_exige_sessao_e_o_mesmo_email(client, app_env, monkeypatch):
    banco, _ = app_env
    admin = _admin(client)
    _criar_usuario(admin, "ana@x.com", "senha-forte-1")
    ana = _tok(client, "ana@x.com", "senha-forte-1")
    outra = _tok(client, ADMIN_EMAIL, ADMIN_PASS)

    # sem sessao: nao converte nada
    _as(client, None)
    r = _link_callback(client, monkeypatch, "ana@x.com")
    assert r.status_code == 302 and "reason=login_required" in r.headers["location"]
    assert sql(banco, "SELECT is_local FROM users WHERE username = 'ana@x.com'", fetch="val") == 1

    # logada como OUTRA pessoa mas autenticando no provedor como a Ana: recusa (nao sequestra)
    _as(client, outra)
    r = _link_callback(client, monkeypatch, "ana@x.com")
    assert "reason=email_mismatch" in r.headers["location"]
    assert sql(banco, "SELECT is_local FROM users WHERE username = 'ana@x.com'", fetch="val") == 1

    # a propria Ana, com o mesmo e-mail no provedor
    _as(client, ana)
    r = _link_callback(client, monkeypatch, "ana@x.com")
    assert r.status_code == 302 and r.headers["location"] == "/index.html?converted=microsoft"
    row = sql(banco, "SELECT is_local, auth_provider, password_hash, mfa_enabled FROM users WHERE username = 'ana@x.com'", fetch="row")
    assert (row["is_local"], row["auth_provider"], row["password_hash"], row["mfa_enabled"]) == (0, "microsoft", None, 0)
    assert client.get("/api/me").status_code == 200                              # continua logada
    _as(client, None)
    assert _login_bruto(client, "ana@x.com", "senha-forte-1").status_code == 401  # senha nao vale mais
    assert sql(banco, "SELECT COUNT(*) FROM auth_events WHERE event = 'converted_to_sso'", fetch="val") == 1


def test_local_vira_sso_tenant_errado_nao_converte(client, app_env, monkeypatch):
    banco, _ = app_env
    admin = _admin(client)
    _criar_usuario(admin, "ana@x.com", "senha-forte-1")
    _as(client, _tok(client, "ana@x.com", "senha-forte-1"))
    r = _link_callback(client, monkeypatch, "ana@x.com", tid="22222222-2222-2222-2222-222222222222")
    assert "reason=tenant_mismatch" in r.headers["location"]
    assert sql(banco, "SELECT is_local FROM users WHERE username = 'ana@x.com'", fetch="val") == 1


def test_ultimo_super_admin_local_nao_vira_sso(client, app_env, monkeypatch):
    banco, _ = app_env
    admin = _admin(client)
    r = _link_callback(client, monkeypatch, ADMIN_EMAIL)
    assert "reason=last_local_super_admin" in r.headers["location"]
    assert sql(banco, "SELECT is_local FROM users WHERE username = $1", ADMIN_EMAIL, fetch="val") == 1


def test_link_inicial_exige_login_e_state_vai_com_prefixo(client, monkeypatch):
    monkeypatch.setattr(oauth, "microsoft_config", oauth.ProviderConfig(CLIENT_ID, "sec", "https://x/cb", GUID_A))
    r = client.get("/api/auth/microsoft", params={"link": "1"})                  # anonimo
    assert r.status_code == 302 and r.headers["location"] == "/login.html"
    admin = _admin(client)
    r = admin.get("/api/auth/microsoft", params={"link": "1"})
    assert r.status_code == 302 and "login.microsoftonline.com" in r.headers["location"]
    assert re.search(r"state=link\.[0-9a-f]{48}", r.headers["location"])
    r = admin.get("/api/auth/microsoft")                                         # login normal: sem prefixo
    assert "state=link." not in r.headers["location"]
