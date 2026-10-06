"""Item 8 da auditoria (out/2026): o papel `admin` NAO alcanca o que leva a
super_admin -- download/restore/exclusao de backup, certificado TLS (chave
privada) e configuracao de OAuth. Rodar a partir de server-py/:

    python -m pytest tests/test_roles.py -v
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_boot import banco, sql  # noqa: E402,F401
from test_security import (  # noqa: E402,F401
    _admin, _as, _back_to_admin, _criar_usuario, _token, app_env, client,
)

SO_SUPER_ADMIN = [
    ("get", "/api/backups/x.dump/download", None),
    ("delete", "/api/backups/x.dump", None),
    ("post", "/api/backups/x.dump/restore", None),
    ("get", "/api/system/ssl-certificate", None),
    ("post", "/api/system/ssl-certificate", {"cert": "x", "key": "y"}),
    ("delete", "/api/system/ssl-certificate", None),
    ("get", "/api/system/oauth", None),
    ("put", "/api/system/oauth/google", {"clientId": "a", "clientSecret": "b", "redirectUri": "https://x/cb"}),
    ("delete", "/api/system/oauth/google", None),
]

PERMITIDAS_AO_ADMIN = [
    ("get", "/api/backups", None, 200),
    ("get", "/api/backup-schedule", None, 200),
    ("get", "/api/audit-log", None, 200),
    ("get", "/api/api-keys", None, 200),
    ("put", "/api/global-settings", {"theme": "dark"}, 204),
]


def _chamar(client, metodo, caminho, corpo=None, headers=None):
    kw = {"headers": headers or {}}
    if corpo is not None:
        kw["json"] = corpo
    return getattr(client, metodo)(caminho, **kw)


@pytest.fixture
def papeis(client):
    """Um super_admin (a conta do setup), um admin comum e um usuario comum."""
    adm = _admin(client)
    _criar_usuario(adm, "admin2@x.com", "senha-forte-1", role="admin")
    _criar_usuario(adm, "user2@x.com", "senha-forte-1", role="user")
    _as(client, None)
    return {
        "admin": _token(client, "admin2@x.com", "senha-forte-1"),
        "user": (_as(client, None), _token(client, "user2@x.com", "senha-forte-1"))[1],
    }


@pytest.mark.parametrize("metodo,caminho,corpo", SO_SUPER_ADMIN)
def test_admin_comum_e_usuario_recebem_403(client, papeis, metodo, caminho, corpo):
    for quem in ("admin", "user"):
        _as(client, papeis[quem])
        r = _chamar(client, metodo, caminho, corpo)
        assert r.status_code == 403, (quem, metodo, caminho, r.status_code, r.text)


def test_anonimo_recebe_401(client):
    _as(client, None)
    for metodo, caminho, corpo in SO_SUPER_ADMIN:
        assert _chamar(client, metodo, caminho, corpo).status_code == 401, (metodo, caminho)


def test_admin_comum_continua_com_o_que_nao_escala_privilegio(client, papeis, app_env):
    _as(client, papeis["admin"])
    for metodo, caminho, corpo, esperado in PERMITIDAS_AO_ADMIN:
        r = _chamar(client, metodo, caminho, corpo)
        assert r.status_code == esperado, (metodo, caminho, r.status_code, r.text)
    r = client.post("/api/backups")  # criar backup continua com admin
    assert r.status_code == 201, r.text


def test_super_admin_alcanca_tudo(client, papeis, app_env):
    _back_to_admin(client)
    nome = client.post("/api/backups").json()["filename"]
    assert client.get(f"/api/backups/{nome}/download").status_code == 200
    assert client.get("/api/system/ssl-certificate").status_code == 200
    assert client.get("/api/system/oauth").status_code == 200
    assert client.post(f"/api/backups/{nome}/restore").status_code == 200
    assert client.delete(f"/api/backups/{nome}").status_code == 204
    # e a tabela users sobreviveu ao restore
    assert sql(app_env[0], "SELECT COUNT(*) FROM users WHERE role = 'super_admin'", fetch="val") == 1


def test_api_key_nunca_alcanca_as_rotas_de_super_admin(client, papeis):
    _back_to_admin(client)
    r = client.post("/api/api-keys", json={"name": "robo", "role": "admin"})
    assert r.status_code == 201, r.text
    chave = r.json()["key"]
    _as(client, None)
    h = {"X-API-Key": chave}
    assert client.get("/api/backups", headers=h).status_code == 200  # a key admin lista
    for metodo, caminho, corpo in SO_SUPER_ADMIN:
        assert _chamar(client, metodo, caminho, corpo, headers=h).status_code == 403, (metodo, caminho)
