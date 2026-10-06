"""Segredos em repouso (app/secrets_box.py + oauth_settings.client_secret cifrado).
Rodar a partir de server-py/:

    python -m pytest tests/test_secrets_box.py -v

A parte da cifra nao precisa de PostgreSQL; a parte de integracao usa o mesmo banco
de teste dos outros modulos (e e pulada se ele nao estiver acessivel).
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app import secrets_box  # noqa: E402
from app.secrets_box import KEY_ENV, PREFIX, SecretUnavailable  # noqa: E402

KEY_A = "a" * 64
KEY_B = "b" * 64


@pytest.fixture
def chave(monkeypatch):
    monkeypatch.setenv(KEY_ENV, KEY_A)
    return KEY_A


# ───────────────────────────── cifra pura ─────────────────────────────
def test_ida_e_volta(chave):
    enc = secrets_box.encrypt("meu-secret", "oauth:google")
    assert enc.startswith(PREFIX) and "meu-secret" not in enc
    assert secrets_box.decrypt(enc, "oauth:google") == "meu-secret"


def test_nonce_novo_a_cada_cifra(chave):
    assert secrets_box.encrypt("x", "c") != secrets_box.encrypt("x", "c")


def test_contexto_errado_nao_decifra(chave):
    enc = secrets_box.encrypt("meu-secret", "oauth:google")
    with pytest.raises(SecretUnavailable):
        secrets_box.decrypt(enc, "oauth:microsoft")


def test_adulterado_nao_decifra(chave):
    enc = secrets_box.encrypt("meu-secret", "oauth:google")
    ruim = enc[:-4] + ("AAAA" if not enc.endswith("AAAA") else "BBBB")
    with pytest.raises(SecretUnavailable):
        secrets_box.decrypt(ruim, "oauth:google")
    for lixo in (PREFIX + "###", PREFIX, PREFIX + "AAAA"):
        with pytest.raises(SecretUnavailable):
            secrets_box.decrypt(lixo, "oauth:google")


def test_chave_errada_nao_decifra(monkeypatch):
    monkeypatch.setenv(KEY_ENV, KEY_A)
    enc = secrets_box.encrypt("meu-secret", "oauth:google")
    monkeypatch.setenv(KEY_ENV, KEY_B)
    with pytest.raises(SecretUnavailable):
        secrets_box.decrypt(enc, "oauth:google")


def test_sem_chave_grava_texto_puro_e_le_legado(monkeypatch):
    monkeypatch.delenv(KEY_ENV, raising=False)
    assert not secrets_box.key_configured()
    assert secrets_box.encrypt("abc", "c") == "abc"
    assert secrets_box.decrypt("abc", "c") == "abc"       # legado em texto puro
    assert secrets_box.decrypt(None, "c") is None and secrets_box.decrypt("", "c") is None


def test_cifrado_sem_chave_levanta(monkeypatch):
    monkeypatch.setenv(KEY_ENV, KEY_A)
    enc = secrets_box.encrypt("abc", "c")
    monkeypatch.delenv(KEY_ENV)
    with pytest.raises(SecretUnavailable):
        secrets_box.decrypt(enc, "c")


def test_chave_curta_e_ignorada(monkeypatch):
    monkeypatch.setenv(KEY_ENV, "curta")
    assert not secrets_box.key_configured()
    assert secrets_box.encrypt("abc", "c") == "abc"
    assert "menos de" in secrets_box.key_problem()
    monkeypatch.delenv(KEY_ENV)
    assert secrets_box.key_problem() is None


def test_utf8_e_secret_grande(chave):
    for s in ("sênha-çõ-日本語", "x" * 5000):
        assert secrets_box.decrypt(secrets_box.encrypt(s, "c"), "c") == s


def test_fingerprint_nao_revela_a_chave(monkeypatch):
    monkeypatch.setenv(KEY_ENV, KEY_A)
    fp = secrets_box.fingerprint()
    assert fp and len(fp) == 8 and KEY_A[:8] not in fp
    monkeypatch.setenv(KEY_ENV, KEY_B)
    assert secrets_box.fingerprint() != fp
    monkeypatch.delenv(KEY_ENV)
    assert secrets_box.fingerprint() is None


# ───────────────────────── integracao com o banco ─────────────────────────
from test_boot import banco, sql  # noqa: E402,F401
from test_security import (  # noqa: E402,F401
    ADMIN_EMAIL, ADMIN_PASS, _admin, app_env, client,
)

from app import oauth  # noqa: E402

OAUTH_BODY = {"clientId": "cid-123", "clientSecret": "SEGREDO-do-google-xyz", "redirectUri": "https://x.example/cb"}


def _linha(banco, provider="google"):
    return sql(banco, "SELECT client_secret, client_id FROM oauth_settings WHERE provider = $1", provider, fetch="row")


def test_put_grava_cifrado_e_a_config_efetiva_vem_em_texto_puro(client, app_env, monkeypatch):
    monkeypatch.setenv(KEY_ENV, KEY_A)
    _admin(client)
    r = client.put("/api/system/oauth/google", json=OAUTH_BODY)
    assert r.status_code == 200, r.text
    row = _linha(app_env[0])
    assert row["client_secret"].startswith(PREFIX)
    assert "SEGREDO-do-google-xyz" not in row["client_secret"]
    assert oauth.google_config.client_secret == "SEGREDO-do-google-xyz" and oauth.google_config.enabled
    st = client.get("/api/system/oauth").json()["google"]
    assert st["configured"] is True and st["clientSecretSet"] is True and st["secretUnreadable"] is False
    assert "SEGREDO" not in client.get("/api/system/oauth").text


def test_editar_sem_novo_secret_mantem_o_existente(client, app_env, monkeypatch):
    monkeypatch.setenv(KEY_ENV, KEY_A)
    _admin(client)
    assert client.put("/api/system/oauth/google", json=OAUTH_BODY).status_code == 200
    r = client.put("/api/system/oauth/google", json={**OAUTH_BODY, "clientId": "cid-novo", "clientSecret": ""})
    assert r.status_code == 200, r.text
    assert oauth.google_config.client_secret == "SEGREDO-do-google-xyz" and oauth.google_config.client_id == "cid-novo"
    assert _linha(app_env[0])["client_secret"].startswith(PREFIX)


def test_sem_chave_continua_funcionando_em_texto_puro(client, app_env, monkeypatch):
    monkeypatch.delenv(KEY_ENV, raising=False)
    _admin(client)
    assert client.put("/api/system/oauth/google", json=OAUTH_BODY).status_code == 200
    assert _linha(app_env[0])["client_secret"] == "SEGREDO-do-google-xyz"
    assert oauth.google_config.enabled


def test_chave_ausente_depois_de_cifrar_desativa_o_provedor_sem_misturar_com_o_ambiente(client, app_env, monkeypatch):
    monkeypatch.setenv(KEY_ENV, KEY_A)
    _admin(client)
    client.put("/api/system/oauth/google", json=OAUTH_BODY)
    monkeypatch.delenv(KEY_ENV)
    monkeypatch.setattr(oauth.settings, "google_client_secret", "ENV-secret")
    import asyncio  # noqa: F401
    # recarrega pela rota (o pool pertence ao event loop do TestClient)
    r = client.put("/api/system/oauth/microsoft", json={**OAUTH_BODY, "tenantId": "common"})
    assert r.status_code == 200
    g = oauth.google_config
    # linha ilegivel -> ignorada por inteiro: nem client_id do banco com secret do ambiente
    assert g.client_id != "cid-123" and g.client_secret == "ENV-secret"
    st = client.get("/api/system/oauth").json()["google"]
    assert st["clientSecretSet"] is True            # vem do ambiente
    # sem env: provedor desativado e o painel sinaliza que o secret nao pode ser lido
    monkeypatch.setattr(oauth.settings, "google_client_secret", "")
    client.put("/api/system/oauth/microsoft", json={**OAUTH_BODY, "tenantId": "common"})
    st = client.get("/api/system/oauth").json()["google"]
    assert st["configured"] is False and st["secretUnreadable"] is True
    # editar sem informar o secret NAO da para reaproveitar o ilegivel: exige de novo
    r = client.put("/api/system/oauth/google", json={**OAUTH_BODY, "clientSecret": ""})
    assert r.status_code == 400 and "Client Secret is required" in r.text


def test_ciphertext_copiado_para_outro_provedor_nao_decifra(client, app_env, monkeypatch):
    monkeypatch.setenv(KEY_ENV, KEY_A)
    _admin(client)
    client.put("/api/system/oauth/google", json=OAUTH_BODY)
    sql(app_env[0], "INSERT INTO oauth_settings (provider, client_id, client_secret, redirect_uri, tenant_id) "
                    "SELECT 'microsoft', 'mid', client_secret, 'https://x.example/ms', 'common' FROM oauth_settings WHERE provider = 'google'",
        fetch="exec")
    client.put("/api/system/oauth/google", json=OAUTH_BODY)   # dispara reload
    assert oauth.microsoft_config.client_secret is None and not oauth.microsoft_config.enabled


def test_boot_cifra_o_que_estava_em_texto_puro(app_env, monkeypatch):
    """Instalacao antiga: secret em texto puro + chave recem-criada -> o boot cifra."""
    from fastapi.testclient import TestClient
    from app.main import app
    banco, _ = app_env
    monkeypatch.delenv(KEY_ENV, raising=False)
    with TestClient(app):   # 1o boot: cria o schema, sem chave
        pass
    sql(banco, "INSERT INTO oauth_settings (provider, client_id, client_secret, redirect_uri) "
               "VALUES ('google', 'cid', 'texto-puro-antigo', 'https://x.example/cb')", fetch="exec")
    with TestClient(app):   # 2o boot, ainda sem chave: avisa e mantem
        assert _linha(banco)["client_secret"] == "texto-puro-antigo"
        assert oauth.google_config.client_secret == "texto-puro-antigo"
    monkeypatch.setenv(KEY_ENV, KEY_A)
    with TestClient(app):   # 3o boot, com chave: cifra
        enc = _linha(banco)["client_secret"]
        assert enc.startswith(PREFIX) and "texto-puro-antigo" not in enc
        assert oauth.google_config.client_secret == "texto-puro-antigo" and oauth.google_config.enabled
    with TestClient(app):   # 4o boot: idempotente (nao cifra duas vezes)
        assert _linha(banco)["client_secret"] == enc


def test_backup_nao_contem_o_secret_em_texto_puro(client, app_env, monkeypatch, tmp_path):
    import shutil
    import subprocess
    if shutil.which("pg_dump") is None or shutil.which("pg_restore") is None:
        pytest.skip("pg_dump/pg_restore nao encontrados")
    monkeypatch.setenv(KEY_ENV, KEY_A)
    _admin(client)
    client.put("/api/system/oauth/google", json=OAUTH_BODY)
    r = client.post("/api/backups")
    assert r.status_code == 201, r.text
    nome = r.json()["filename"]
    dump = tmp_path / "x.dump"
    dump.write_bytes(client.get(f"/api/backups/{nome}/download").content)
    # o dump (formato custom) e comprimido: converte para SQL de texto antes de procurar
    sql_texto = subprocess.run(["pg_restore", "-f", "-", str(dump)], capture_output=True, text=True, check=True).stdout
    assert "oauth_settings" in sql_texto and "cid-123" in sql_texto    # a linha esta no dump...
    assert "SEGREDO-do-google-xyz" not in sql_texto                    # ...mas o secret nao
    assert PREFIX in sql_texto
