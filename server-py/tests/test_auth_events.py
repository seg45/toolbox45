"""Eventos de acesso (app/auth_events.py + GET /api/auth-events): login, falha,
bloqueio, setup, cadastro, troca/redefinicao de senha e OAuth ficam gravados,
sem nunca guardar senha, e so o super_admin le. Rodar a partir de server-py/:

    python -m pytest tests/test_auth_events.py -v
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_boot import banco, sql  # noqa: E402,F401
from test_security import (  # noqa: E402,F401
    ADMIN_EMAIL, ADMIN_PASS, _admin, _as, _back_to_admin, _criar_usuario, _token, app_env, client,
    _callback, _jwt, CLIENT_ID, GUID_B, _usuario_ms,
)

from app import auth_events, login_guard  # noqa: E402


@pytest.fixture(autouse=True)
def _estado_limpo():
    login_guard.login_limiter.reset()
    login_guard.password_change_limiter.reset()
    auth_events._blocked_seen.clear()
    auth_events._last_purge = float("-inf")
    yield
    login_guard.login_limiter.reset()
    login_guard.password_change_limiter.reset()


def _eventos(banco, where="TRUE", *args):
    rows = sql(banco, f"SELECT event, username, ip, user_agent, detail FROM auth_events WHERE {where} ORDER BY id", *args)
    return [dict(r) for r in rows]


def _login_raw(client, user, password, ua="pytest-agent/1.0"):
    return client.post("/api/auth/login", json={"username": user, "password": password}, headers={"user-agent": ua})


def test_setup_fica_registrado(client, app_env):
    ev = _eventos(app_env[0], "event = 'setup_completed'")
    assert len(ev) == 1 and ev[0]["username"] == ADMIN_EMAIL and ev[0]["detail"] == "mode=fresh"


def test_login_sucesso_e_falha(client, app_env):
    banco, _ = app_env
    assert _login_raw(client, ADMIN_EMAIL, ADMIN_PASS).status_code == 200
    client.cookies.clear()
    assert _login_raw(client, ADMIN_EMAIL, "senha-errada-9").status_code == 401
    assert _login_raw(client, "ninguem@x.com", "qualquer-coisa").status_code == 401
    ev = _eventos(banco, "event IN ('login_success','login_failed')")
    assert [(e["event"], e["username"], e["detail"]) for e in ev] == [
        ("login_success", ADMIN_EMAIL, None),
        ("login_failed", ADMIN_EMAIL, "bad_password"),
        ("login_failed", "ninguem@x.com", "unknown_user"),
    ]
    assert all(e["user_agent"] == "pytest-agent/1.0" and e["ip"] for e in ev)


def test_conta_desativada_e_motivo_proprio(client, app_env):
    banco, _ = app_env
    adm = _admin(client)
    _criar_usuario(adm, "off@x.com", "senha-forte-1")
    r = adm.put("/api/users/off@x.com", json={"disabled": True})
    assert r.status_code == 200, r.text
    _as(client, None)
    assert _login_raw(client, "off@x.com", "senha-forte-1").status_code == 401
    assert _eventos(banco, "username = 'off@x.com' AND event = 'login_failed'")[0]["detail"] == "account_disabled"


def test_usuario_que_nao_parece_email_nao_e_gravado(client, app_env):
    """Quem digita a senha no campo de usuario nao pode deixar a senha no log."""
    banco, _ = app_env
    segredo = "MinhaSenhaSecreta#2026"
    assert _login_raw(client, segredo, "x-qualquer-9").status_code == 401
    assert _login_raw(client, "linha\nquebrada\x00@x.com", "x-qualquer-9").status_code == 401
    todos = sql(banco, "SELECT row_to_json(a)::text AS j FROM auth_events a")
    texto = " ".join(r["j"] for r in todos)
    assert segredo not in texto
    ev = _eventos(banco, "event = 'login_failed'")
    assert ev[0]["username"] == "(formato invalido)"
    assert "\n" not in (ev[1]["username"] or "") and "\x00" not in (ev[1]["username"] or "")


def test_nenhuma_senha_ou_hash_e_gravada(client, app_env):
    banco, _ = app_env
    _login_raw(client, ADMIN_EMAIL, "errada-12345")
    _login_raw(client, ADMIN_EMAIL, ADMIN_PASS)
    hashes = sql(banco, "SELECT password_hash FROM users")
    todos = " ".join(r["j"] for r in sql(banco, "SELECT row_to_json(a)::text AS j FROM auth_events a"))
    assert "errada-12345" not in todos and ADMIN_PASS not in todos
    assert all(h["password_hash"] not in todos for h in hashes)


def test_bloqueio_grava_uma_linha_por_minuto_mesmo_com_enxurrada(client, app_env):
    banco, _ = app_env
    for _ in range(5):
        assert _login_raw(client, ADMIN_EMAIL, "errada-12345").status_code == 401
    for _ in range(12):  # tentativas depois do bloqueio
        assert _login_raw(client, ADMIN_EMAIL, "errada-12345").status_code == 429
    ev = _eventos(banco, "event = 'login_blocked'")
    assert len(ev) == 1 and ev[0]["username"] == ADMIN_EMAIL and ev[0]["detail"].startswith("retry_after=")
    assert len(_eventos(banco, "event = 'login_failed'")) == 5  # as bloqueadas nao contam como falha


def test_troca_de_senha(client, app_env):
    banco, _ = app_env
    adm = _admin(client)
    _criar_usuario(adm, "u1@x.com", "senha-forte-1")
    _as(client, _token(client, "u1@x.com", "senha-forte-1"))
    r = client.put("/api/me/password", json={"current_password": "errada-1234", "new_password": "nova-senha-123"})
    assert r.status_code == 401
    r = client.put("/api/me/password", json={"current_password": "senha-forte-1", "new_password": "nova-senha-123"})
    assert r.status_code == 204, r.text
    ev = _eventos(banco, "username = 'u1@x.com' AND event LIKE 'password_%'")
    assert [(e["event"], e["detail"]) for e in ev] == [
        ("password_change_failed", "wrong_current_password"),
        ("password_changed", "other_sessions_revoked=0"),
    ]
    assert "nova-senha-123" not in " ".join(r["j"] for r in sql(banco, "SELECT row_to_json(a)::text AS j FROM auth_events a"))


def test_troca_de_senha_bloqueada(client, app_env):
    banco, _ = app_env
    adm = _admin(client)
    _criar_usuario(adm, "u2@x.com", "senha-forte-1")
    _as(client, _token(client, "u2@x.com", "senha-forte-1"))
    for _ in range(5):
        client.put("/api/me/password", json={"current_password": "errada-1234", "new_password": "nova-senha-123"})
    r = client.put("/api/me/password", json={"current_password": "senha-forte-1", "new_password": "nova-senha-123"})
    assert r.status_code == 429
    assert len(_eventos(banco, "event = 'password_change_blocked'")) == 1


def test_admin_redefine_senha_de_outro(client, app_env):
    banco, _ = app_env
    adm = _admin(client)
    _criar_usuario(adm, "u3@x.com", "senha-forte-1")
    r = adm.put("/api/users/u3@x.com", json={"password": "outra-senha-123"})
    assert r.status_code == 200, r.text
    ev = _eventos(banco, "event = 'password_reset_by_admin'")
    assert len(ev) == 1 and ev[0]["username"] == "u3@x.com" and ev[0]["detail"].startswith(f"by={ADMIN_EMAIL}")


def test_cadastro(client, app_env):
    r = client.post("/api/auth/register", json={"email": "novo@x.com", "password": "senha-forte-1"})
    assert r.status_code == 201, r.text
    ev = _eventos(app_env[0], "event = 'register'")
    assert len(ev) == 1 and ev[0]["username"] == "novo@x.com" and ev[0]["detail"] == "pending_approval"


def test_oauth_falha_e_sucesso(client, app_env, monkeypatch):
    banco, _ = app_env
    _usuario_ms(banco, "vitima@corp.com")
    bom = _jwt({"aud": CLIENT_ID, "tid": GUID_B, "preferred_username": "vitima@corp.com"})
    ruim = _jwt({"aud": CLIENT_ID, "tid": GUID_B, "preferred_username": "atacante@evil.com"})
    _callback(client, monkeypatch, "common", ruim, {"email": "vitima@corp.com"})
    r = _callback(client, monkeypatch, "common", bom, {"email": "vitima@corp.com"})
    assert r.headers["location"] == "/login.html?microsoft=success"
    ev = _eventos(banco, "event LIKE 'oauth_%'")
    assert [(e["event"], e["username"], e["detail"]) for e in ev] == [
        ("oauth_failed", "vitima@corp.com", "microsoft:email_not_verified"),
        ("oauth_login", "vitima@corp.com", "microsoft"),
    ]


# ───────────────────────────── consulta ─────────────────────────────
def test_somente_super_admin_le(client, app_env):
    adm = _admin(client)
    _criar_usuario(adm, "adm2@x.com", "senha-forte-1", role="admin")
    _criar_usuario(adm, "usr@x.com", "senha-forte-1")
    r = client.post("/api/api-keys", json={"name": "robo", "role": "admin"})
    chave = r.json()["key"]
    for quem in ("adm2@x.com", "usr@x.com"):
        _as(client, None)
        _as(client, _token(client, quem, "senha-forte-1"))
        assert client.get("/api/auth-events").status_code == 403, quem
    _as(client, None)
    assert client.get("/api/auth-events").status_code == 401
    assert client.get("/api/auth-events", headers={"X-API-Key": chave}).status_code == 403
    _back_to_admin(client)
    assert client.get("/api/auth-events").status_code == 200


def test_consulta_filtros(client, app_env):
    adm = _admin(client)
    _criar_usuario(adm, "f1@x.com", "senha-forte-1")
    _as(client, None)
    _login_raw(client, "f1@x.com", "errada-12345")
    _back_to_admin(client)
    todos = client.get("/api/auth-events").json()
    assert todos and set(todos[0]) == {"id", "ts", "event", "username", "ip", "user_agent", "detail"}
    assert todos == sorted(todos, key=lambda e: (e["ts"], e["id"]), reverse=True)
    so_falhas = client.get("/api/auth-events", params={"event": "login_failed"}).json()
    assert so_falhas and all(e["event"] == "login_failed" for e in so_falhas)
    do_usuario = client.get("/api/auth-events", params={"username": "f1@x.com"}).json()
    assert do_usuario and all(e["username"] == "f1@x.com" for e in do_usuario)
    assert len(client.get("/api/auth-events", params={"limit": 1}).json()) == 1
    assert client.get("/api/auth-events", params={"hours": 1}).json()
    assert client.get("/api/auth-events", params={"event": "inventado"}).status_code == 400
    assert client.get("/api/auth-events", params={"limit": 0}).status_code == 400
    assert client.get("/api/auth-events", params={"limit": 5000}).status_code == 400


def test_filtro_de_horas_exclui_o_antigo(client, app_env):
    banco, _ = app_env
    sql(banco, "INSERT INTO auth_events (ts, event, username) VALUES (NOW() - INTERVAL '3 hours', 'login_success', 'velho@x.com')", fetch="exec")
    _admin(client)
    users = {e["username"] for e in client.get("/api/auth-events", params={"hours": 2}).json()}
    assert "velho@x.com" not in users
    users = {e["username"] for e in client.get("/api/auth-events", params={"hours": 4}).json()}
    assert "velho@x.com" in users


def test_retencao_e_teto(client, app_env, monkeypatch):
    banco, _ = app_env
    sql(banco, "INSERT INTO auth_events (ts, event, username) VALUES (NOW() - INTERVAL '181 days', 'login_success', 'antigo@x.com'), (NOW() - INTERVAL '179 days', 'login_success', 'recente@x.com')", fetch="exec")
    # a limpeza roda dentro da rota de login (o pool pertence ao event loop do TestClient)
    auth_events._last_purge = float("-inf")
    _login_raw(client, ADMIN_EMAIL, ADMIN_PASS)
    nomes = {r["username"] for r in sql(banco, "SELECT username FROM auth_events")}
    assert "antigo@x.com" not in nomes and "recente@x.com" in nomes

    monkeypatch.setattr(auth_events, "MAX_ROWS", 5)
    sql(banco, "INSERT INTO auth_events (event, username) SELECT 'login_success', 'm' || g FROM generate_series(1, 20) g", fetch="exec")
    auth_events._last_purge = float("-inf")
    _login_raw(client, ADMIN_EMAIL, ADMIN_PASS)
    assert sql(banco, "SELECT COUNT(*) FROM auth_events", fetch="val") <= 5


def test_falha_ao_gravar_nunca_derruba_o_login(client, app_env):
    banco, _ = app_env
    sql(banco, "ALTER TABLE auth_events RENAME TO auth_events_off", fetch="exec")
    try:
        assert _login_raw(client, ADMIN_EMAIL, ADMIN_PASS).status_code == 200
    finally:
        sql(banco, "ALTER TABLE auth_events_off RENAME TO auth_events", fetch="exec")


def test_renomear_admin_na_migracao_leva_os_eventos(app_env):
    """auth_events.username esta em USERNAME_REFERENCES (setup de instalacao antiga)."""
    from app import setup
    assert ("auth_events", "username") in setup.USERNAME_REFERENCES


def test_byte_nul_no_login_e_no_cadastro_nao_gera_500(client, app_env):
    """Regressao: o Postgres rejeita \\x00 em TEXT; antes isso virava 500."""
    assert _login_raw(client, "a\x00b@x.com", "x-qualquer-9").status_code == 401
    r = client.post("/api/auth/register", json={"email": "a\x00b@x.com", "password": "senha-forte-1"})
    assert r.status_code == 400, r.text
    r = client.post("/api/auth/setup", json={"email": "a\x00b@x.com", "password": "senha-forte-1"})
    assert r.status_code in (400, 409), r.text
