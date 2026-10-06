"""Testes das correcoes da auditoria de seguranca (out/2026): sanitizador de
HTML, cookie Secure, politica de senha, /api/global-settings e /api/user-data,
logo publico, backup sem senha na linha de comando / erros genericos e login
Microsoft (nOAuth). Rodar a partir de server-py/:

    python -m pytest tests/test_security.py -v

Mesma exigencia de test_boot.py: PostgreSQL alcancavel por PGHOST/PGPORT/
PGUSER/PGPASSWORD (senao o modulo e pulado); cada teste usa um banco proprio.
"""
import asyncio
import base64
import json
import random
import re
import shutil
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_boot import banco, sql  # noqa: E402,F401  (fixture + helper do boot)

from app import backup, oauth, tls  # noqa: E402
from app.sanitize import sanitize_note_html  # noqa: E402

# ════════════════════════════════════════════════
# 1) Sanitizador de HTML (sem banco)
# ════════════════════════════════════════════════
ALLOWED = {"b", "strong", "i", "em", "u", "br", "p", "div", "span", "ul", "ol", "li", "a", "img"}

ATTACKS = [
    "<img src=x onerror=alert(1) <b>",                      # bypass do sanitizador antigo
    "<img src=x onerror=alert(1) <",
    '<div style="x" onmouseover=alert(1) <i>hi</i>',
    "<p>ok</p><img src=x onerror=alert(1) \n<b>",
    '<a href="java\tscript:alert(1)">x</a>',
    '<a href="&#106;avascript:alert(1)">x</a>',
    "<a href=javascript:alert(1)>x</a>",
    '<img src="javascript:alert(1)">',
    "<svg onload=alert(1)>",
    "<script>alert(1)</script>x",
    "<script>alert(1)",
    "<scr<script>ipt>alert(1)</scr</script>ipt>",
    "<!-- <img src=x onerror=alert(1)> -->",
    "<style>*{x}</style><b>k</b>",
    "<iframe src=//evil></iframe>",
    '<img src="x" onerror="alert(1)">',
    "<b onclick=alert(1)>x</b>",
    '<math><mi//xlink:href="data:x,<script>alert(1)</script>">',
    "<![CDATA[<img src=x onerror=alert(1)>]]>",
    '<a href="https://x.com" onclick="alert(1)">x</a>',
    '<img src="https://x.com/a.png"onerror=alert(1)>',
    "<<img src=x onerror=alert(1)>",
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
]


def _perigoso(saida: str) -> bool:
    for tag, resto in re.findall(r"<\s*/?\s*([a-zA-Z0-9]+)([^>]*)>", saida):
        if tag.lower() not in ALLOWED:
            return True
        if re.search(r"\bon\w+\s*=", resto, re.I):
            return True
        if re.search(r"javascript:", resto, re.I):
            return True
    return False


@pytest.mark.parametrize("ataque", ATTACKS)
def test_sanitizador_neutraliza_ataques(ataque):
    saida = sanitize_note_html(ataque)
    assert not _perigoso(saida), f"{ataque!r} -> {saida!r}"
    assert "onerror" not in saida.lower().replace("&lt;", "") or "<" not in saida.split("onerror")[0][-40:]


def test_sanitizador_fuzz_nunca_gera_html_perigoso_e_e_idempotente():
    frag = ["<", ">", "<b>", "</b>", "<img src=x onerror=1", '<a href="', '"', "'", "=", "javascript:",
            "<script>", "</script>", "&", "&amp;", "&#x3c;", "x", '<div style="color:#fff">', "</div>",
            "<!--", "-->", "<br/>", "\n", "<font color=#fff>", "</font>", "<p>", "</p>", "onerror=", "<svg/onload=1>"]
    rnd = random.Random(7)
    for _ in range(5000):
        entrada = "".join(rnd.choice(frag) for _ in range(rnd.randint(1, 14)))
        saida = sanitize_note_html(entrada)
        assert not _perigoso(saida), f"{entrada!r} -> {saida!r}"
        assert sanitize_note_html(saida) == saida, f"nao idempotente: {entrada!r} -> {saida!r}"


@pytest.mark.parametrize("entrada,esperado", [
    ("<b>bold</b> and <i>it</i>", "<b>bold</b> and <i>it</i>"),
    ('<font color="#ff0000">red</font>', '<span style="color:#ff0000">red</span>'),
    ('<span style="color: rgb(1,2,3); font-size:14px; position:absolute">x</span>', '<span style="color:rgb(1,2,3);font-size:14px">x</span>'),
    ('<img src="data:image/png;base64,iVBOR=" width="100" height=50>', '<img src="data:image/png;base64,iVBOR=" width="100" height="50">'),
    ("<ul><li>a</li><li>b</li></ul>", "<ul><li>a</li><li>b</li></ul>"),
    ("a &amp; b &lt; c", "a &amp; b &lt; c"),
    ("line<br>two<br/>three", "line<br>two<br>three"),
    ('<p style="text-align:CENTER">x</p>', '<p style="text-align:center">x</p>'),
    ('<a href="https://a.com/x?a=1&b=2">l</a>', '<a href="https://a.com/x?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">l</a>'),
    ('<a href="mailto:a@b.c">m</a>', '<a href="#" target="_blank" rel="noopener noreferrer">m</a>'),
    ("a < b and c > d", "a &lt; b and c &gt; d"),
    ("", ""),
])
def test_sanitizador_preserva_conteudo_legitimo(entrada, esperado):
    assert sanitize_note_html(entrada) == esperado


def test_sanitizador_fecha_tags_e_ignora_fechamento_orfao():
    assert sanitize_note_html("<b>x<i>y") == "<b>x<i>y</i></b>"
    assert sanitize_note_html("</div></div><b>x") == "<b>x</b>"
    assert sanitize_note_html("<b><i>x</b>y") == "<b><i>x</i></b>y"


# ════════════════════════════════════════════════
# Infra de teste ponta a ponta (FastAPI + banco novo)
# ════════════════════════════════════════════════
PNG_1X1 = ("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


@pytest.fixture
def app_env(banco, monkeypatch, tmp_path):
    if shutil.which("openssl") is None:
        pytest.skip("openssl nao encontrado (bootstrap TLS do lifespan)")
    tls_dir, backup_dir = tmp_path / "tls", tmp_path / "backups"
    monkeypatch.setenv("TLS_DIR", str(tls_dir))
    monkeypatch.setenv("BACKUP_DIR", str(backup_dir))
    monkeypatch.setattr(tls, "TLS_DIR", tls_dir)
    monkeypatch.setattr(tls, "TLS_CERT_PATH", tls_dir / "cert.pem")
    monkeypatch.setattr(tls, "TLS_KEY_PATH", tls_dir / "key.pem")
    monkeypatch.setattr(tls, "TLS_BACKUP_DIR", tls_dir / "backup")
    monkeypatch.setattr(backup, "BACKUP_DIR", backup_dir)
    return banco, backup_dir


ADMIN_EMAIL = "root@test.local"
ADMIN_PASS = "senha-admin-1"


@pytest.fixture
def client(app_env):
    from fastapi.testclient import TestClient
    from app.main import app
    with TestClient(app, follow_redirects=False) as c:
        # Nao existe conta padrao: o primeiro super_admin nasce na configuracao inicial.
        r = c.post("/api/auth/setup", json={"email": ADMIN_EMAIL, "password": ADMIN_PASS})
        assert r.status_code == 200, r.text
        c.post("/api/auth/logout")  # descarta a sessao aberta pelo setup (os testes logam por conta propria)
        c.cookies.clear()
        yield c


def _login(client, user=ADMIN_EMAIL, password=ADMIN_PASS, headers=None):
    r = client.post("/api/auth/login", json={"username": user, "password": password}, headers=headers or {})
    assert r.status_code == 200, r.text
    return r


def _token(client, user, password):
    """Faz login e devolve o token de sessao (para alternar entre usuarios no
    MESMO TestClient -- um segundo TestClient/lifespan reabriria o pool global
    do asyncpg em outro event loop)."""
    _login(client, user, password)
    return client.cookies.get("tb45_session")


def _as(client, token):
    """Passa a requisitar como o dono do token (None = anonimo)."""
    client.cookies.clear()
    if token:
        client.cookies.set("tb45_session", token)


ADMIN_TOKENS = {}


def _admin(client):
    """Loga como admin; o token fica guardado para voltar a ele depois de
    alternar de usuario (ver _as)."""
    ADMIN_TOKENS[id(client)] = _token(client, ADMIN_EMAIL, ADMIN_PASS)
    return client


def _back_to_admin(client):
    _as(client, ADMIN_TOKENS[id(client)])


def _criar_usuario(admin, email, password="senha-forte-1", role="user"):
    r = admin.post("/api/users", json={"username": email, "password": password, "role": role})
    assert r.status_code == 201, r.text
    return email, password


def _cmd_payload(**extra):
    return {"name": "Cmd", "topics": ["t1"], "vendors": ["check-point"], "systems": ["gaia"],
            "versions": ["r82"], "environments": ["firewall"], **extra}


def _criar_topico(admin):
    r = admin.post("/api/topics", json={"label": "T1"})
    assert r.status_code == 201, r.text
    return r.json()["key"]


# ════════════════════════════════════════════════
# 2) XSS armazenado: HTML malicioso enviado pela API nao fica no banco
# ════════════════════════════════════════════════
def test_details_de_comando_e_notas_sao_sanitizados_pela_api(client, app_env):
    banco, _ = app_env
    admin = _admin(client)
    topico = _criar_topico(admin)
    _criar_usuario(admin, "u1@teste.com")
    u1 = admin
    _as(client, _token(client, "u1@teste.com", "senha-forte-1"))
    if True:
        ataque = "<img src=x onerror=alert(1) <b>negrito</b> <a href=\"javascript:alert(2)\">l</a>"
        r = u1.post("/api/commands", json=_cmd_payload(topics=[topico], details=ataque))
        assert r.status_code == 201, r.text
        cid = r.json()["id"]
        gravado = sql(banco, "SELECT details FROM commands WHERE id = $1", cid, fetch="val")
        assert not _perigoso(gravado) and "javascript:" not in gravado and "onerror" not in gravado, gravado
        got = u1.get(f"/api/commands/{cid}").json()
        assert not _perigoso(got["details"]), got["details"]

        # nota de pasta
        pasta = u1.post("/api/folders", json={"name": "P"})
        assert pasta.status_code == 201, pasta.text
        fid = pasta.json()["id"]
        rn = u1.post(f"/api/folders/{fid}/notes", json={"title": "n", "description": ataque})
        assert rn.status_code in (200, 201), rn.text
        nota = sql(banco, "SELECT description FROM notes WHERE folder_id = $1", fid, fetch="val")
        assert not _perigoso(nota) and "onerror" not in nota, nota


# ════════════════════════════════════════════════
# 3) Cookie de sessao: Secure so quando a requisicao veio por HTTPS
# ════════════════════════════════════════════════
def test_cookie_de_sessao_secure_atras_do_proxy_https(client):
    r = client.post("/api/auth/login", json={"username": ADMIN_EMAIL, "password": ADMIN_PASS},
                    headers={"X-Forwarded-Proto": "https"})
    cookie = r.headers["set-cookie"]
    assert "tb45_session=" in cookie and "Secure" in cookie and "HttpOnly" in cookie and "SameSite=lax" in cookie

    r = client.post("/api/auth/login", json={"username": ADMIN_EMAIL, "password": ADMIN_PASS},
                    headers={"X-Forwarded-Proto": "http"})
    assert "Secure" not in r.headers["set-cookie"]

    # sem proxy (acesso direto, testes): nao marca Secure (senao o navegador descartaria o cookie em HTTP)
    r = client.post("/api/auth/login", json={"username": ADMIN_EMAIL, "password": ADMIN_PASS})
    assert "Secure" not in r.headers["set-cookie"]

    # logout por HTTPS limpa o cookie com os mesmos atributos
    r = client.post("/api/auth/logout", headers={"X-Forwarded-Proto": "https"})
    assert r.status_code == 204
    assert "tb45_session=" in r.headers["set-cookie"] and "Secure" in r.headers["set-cookie"]


def test_cookie_de_estado_oauth_secure_atras_do_proxy_https(client, monkeypatch):
    monkeypatch.setattr(oauth, "microsoft_config", oauth.ProviderConfig("cid", "sec", "https://x/cb", "common"))
    r = client.get("/api/auth/microsoft", headers={"X-Forwarded-Proto": "https"})
    assert r.status_code == 302
    assert "tb45_oauth_state_ms=" in r.headers["set-cookie"] and "Secure" in r.headers["set-cookie"]
    r = client.get("/api/auth/microsoft")
    assert "Secure" not in r.headers["set-cookie"]


# ════════════════════════════════════════════════
# 4) Politica de senha (so para senhas NOVAS)
# ════════════════════════════════════════════════
def test_politica_de_senha_no_registro_e_na_administracao(client, app_env):
    banco, _ = app_env
    # registro
    for senha in ("1234567", "", "a" * 257):
        r = client.post("/api/auth/register", json={"email": "novo@teste.com", "password": senha})
        assert r.status_code == 400 and r.json()["error"] == "validation_error", (senha[:5], r.text)
    r = client.post("/api/auth/register", json={"email": "novo@teste.com", "password": "novo@teste.com"})
    assert r.status_code == 400 and "same as" in r.json()["message"]
    r = client.post("/api/auth/register", json={"email": "novo@teste.com", "password": "12345678"})
    assert r.status_code == 201, r.text

    admin = _admin(client)
    # criacao de usuario
    r = admin.post("/api/users", json={"username": "b@teste.com", "password": "1234567"})
    assert r.status_code == 400 and "at least 8" in r.json()["message"]
    r = admin.post("/api/users", json={"username": "b@teste.com", "password": "12345678"})
    assert r.status_code == 201
    # reset de senha
    r = admin.put("/api/users/b@teste.com", json={"password": "abc"})
    assert r.status_code == 400 and "at least 8" in r.json()["message"]
    r = admin.put("/api/users/b@teste.com", json={"password": "outra-senha-9"})
    assert r.status_code == 200


def test_login_continua_aceitando_senha_curta_antiga(client, app_env):
    banco, _ = app_env
    from app.security import hash_password
    sql(banco, "INSERT INTO users (username, password_hash, role, is_local, created_by, auth_provider, handle, approved_at) "
               "VALUES ('velho@teste.com', $1, 'user', 1, 'system', 'local', 'velho', NOW())",
        hash_password("abcd"), fetch="exec")
    r = client.post("/api/auth/login", json={"username": "velho@teste.com", "password": "abcd"})
    assert r.status_code == 200, r.text


# ════════════════════════════════════════════════
# 5) /api/user-data e /api/global-settings
# ════════════════════════════════════════════════
def test_global_settings_so_admin_grava_e_chaves_reservadas_sao_protegidas(client, app_env):
    admin = _admin(client)
    _criar_usuario(admin, "u2@teste.com")
    tok_u2 = _token(client, "u2@teste.com", "senha-forte-1")
    u2 = client
    if True:
        # usuario comum nao grava defaults compartilhados
        _as(client, tok_u2)
        r = u2.put("/api/global-settings", json={"team-default": "x"})
        assert r.status_code == 403, r.text
        r = u2.put("/api/global-settings", json={"backupScheduleEnabled": "0"})
        assert r.status_code == 403
        _back_to_admin(client)

        # admin grava chaves comuns, mas nao as reservadas (rotas dedicadas)
        assert admin.put("/api/global-settings", json={"team-default": "x"}).status_code == 204
        for chave in ("backupScheduleEnabled", "backupScheduleLastRunDate", "appearanceTheme", "appearanceAccent"):
            r = admin.put("/api/global-settings", json={chave: "x"})
            assert r.status_code == 400 and "reserved" in r.json()["message"], (chave, r.text)

        # GET: usuario comum nao ve as chaves do agendamento de backup
        assert admin.put("/api/backup-schedule", json={"enabled": True, "frequency": "daily", "time": "03:30"}).status_code == 204
        vis_admin = admin.get("/api/global-settings").json()
        _as(client, tok_u2)
        vis_user = u2.get("/api/global-settings").json()
        _back_to_admin(client)
        assert vis_admin.get("backupScheduleEnabled") == "1" and vis_admin.get("team-default") == "x"
        assert "team-default" in vis_user and not any(k.startswith("backupSchedule") for k in vis_user)
        # e o agendamento so muda pela rota dedicada (admin)
        assert admin.get("/api/backup-schedule").json()["time"] == "03:30"


def test_user_data_valida_chaves_valores_e_quotas(client):
    admin = _admin(client)
    # chaves que o app realmente usa (inclui ':' e e-mail) continuam funcionando
    ok = {"cpa-settings": json.dumps({"a": 1}), "cpa-theme": "dark", "cpa-query-history:a@b.com": "[]",
          "cpa-cmdsearch-history:fulano.silva+x@empresa.com.br": "[\"x\"]", "num": 5, "flag": True, "ignorada": None}
    assert admin.put("/api/user-data", json=ok).status_code == 204
    got = admin.get("/api/user-data").json()
    assert got["cpa-theme"] == "dark" and got["num"] == "5" and "ignorada" not in got
    assert got["cpa-cmdsearch-history:fulano.silva+x@empresa.com.br"] == '["x"]'

    for corpo, trecho in [
        ({"chave com espaco": "x"}, "Invalid key"),
        ({"a/b": "x"}, "Invalid key"),
        ({"x" * 161: "x"}, "Invalid key"),
        ({"k": {"aninhado": 1}}, "must be text"),
        ({"k": [1, 2]}, "must be text"),
        ({"k": "x" * (256 * 1024 + 1)}, "too large"),
        ({f"k{i}": "x" for i in range(65)}, "Too many keys"),
        ([1, 2], "JSON object"),
    ]:
        r = admin.put("/api/user-data", json=corpo)
        assert r.status_code == 400 and trecho in r.json()["message"], (str(corpo)[:50], r.text)

    # teto de chaves por dono (300): enche em lotes de 60 ate estourar
    lote = lambda n: {f"q{n}-{i}": "1" for i in range(60)}  # noqa: E731
    estourou = None
    for n in range(6):
        r = admin.put("/api/user-data", json=lote(n))
        if r.status_code == 400:
            estourou = r
            break
    assert estourou is not None and estourou.json()["error"] == "too_many_keys"
    # sobrescrever chave existente nao conta como chave nova
    assert admin.put("/api/user-data", json={"cpa-theme": "light"}).status_code == 204


# ════════════════════════════════════════════════
# 6) Logo publico nao expoe quem atualizou
# ════════════════════════════════════════════════
def test_logo_publico_nao_vaza_updated_by(client):
    admin = _admin(client)
    r = admin.put("/api/system/logo", json={"imageData": PNG_1X1, "theme": "light"})
    assert r.status_code == 200, r.text
    _as(client, None)
    pub = client.get("/api/system/logo").json()
    assert pub["imageData"] == PNG_1X1 and pub["updatedBy"] is None and pub["updatedByDark"] is None
    # API key invalida numa rota publica nao vira 401
    assert client.get("/api/system/logo", headers={"X-API-Key": "tb45_invalida"}).status_code == 200
    _back_to_admin(client)
    adm = admin.get("/api/system/logo").json()
    assert adm["updatedBy"] == ADMIN_EMAIL


# ════════════════════════════════════════════════
# 7) Backup: senha fora da linha de comando; erros genericos
# ════════════════════════════════════════════════
def test_pg_cli_target_tira_a_senha_do_dsn(monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "database_url", "postgresql://us%40er:p%40ss%2Fw:rd@db.local:5433/meu?sslmode=require")
    dsn, env = backup.pg_cli_target()
    assert "p%40ss" not in dsn and "p@ss" not in dsn and "rd@" not in dsn
    assert dsn == "postgresql://us%40er@db.local:5433/meu?sslmode=require"
    assert env["PGPASSWORD"] == "p@ss/w:rd"
    # sem senha no DSN: nao mexe
    monkeypatch.setattr(settings, "database_url", "postgresql://u@h/d")
    dsn, env = backup.pg_cli_target()
    assert dsn == "postgresql://u@h/d"


def test_backup_e_restore_reais_sem_senha_nos_argumentos(client, monkeypatch):
    if shutil.which("pg_dump") is None or shutil.which("pg_restore") is None:
        pytest.skip("pg_dump/pg_restore ausentes")
    admin = _admin(client)
    chamadas = []
    original = asyncio.create_subprocess_exec

    async def espiao(cmd, *args, **kw):
        chamadas.append((cmd, args, kw.get("env")))
        return await original(cmd, *args, **kw)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", espiao)
    r = admin.post("/api/backups")
    assert r.status_code == 201, r.text
    nome = r.json()["filename"]
    r = admin.post(f"/api/backups/{nome}/restore")
    assert r.status_code == 200, r.text
    clis = [c for c in chamadas if c[0] in ("pg_dump", "pg_restore")]
    assert len(clis) >= 3  # backup + pre-restore + restore
    from app.config import settings
    senha = settings.dsn().split("//", 1)[1].split("@", 1)[0].split(":", 1)[1]
    for cmd, args, env in clis:
        # (o teste usa senha == usuario, entao so "usuario:senha@" denuncia a senha na URL)
        assert f":{senha}@" not in " ".join(args), f"senha do banco na linha de comando de {cmd}"
        assert env and env.get("PGPASSWORD") == senha


def test_erros_de_backup_nao_vazam_detalhes(client, monkeypatch):
    admin = _admin(client)

    async def falha(*a, **kw):
        raise RuntimeError("pg_dump: error: connection to server at 10.0.0.5 failed: postgresql://u:SEGREDO@h/d")

    monkeypatch.setattr(backup, "perform_backup", falha)
    r = admin.post("/api/backups")
    assert r.status_code == 500
    corpo = r.text
    assert "SEGREDO" not in corpo and "10.0.0.5" not in corpo and "pg_dump" not in corpo
    assert r.json() == {"error": "internal_error", "message": "The operation failed. See the server log for details."}


def test_validacao_nao_ecoa_o_valor_recebido(client):
    admin = _admin(client)
    # corpo com tipo invalido numa rota com modelo pydantic
    r = client.post("/api/auth/login", content=b'{"username": ["valor-secreto-xyz"]}', headers={"Content-Type": "application/json"})
    assert r.status_code == 400 and r.json()["error"] == "validation_error"
    assert "valor-secreto-xyz" not in r.text
    assert admin is not None


# ════════════════════════════════════════════════
# 8) Login Microsoft (nOAuth)
# ════════════════════════════════════════════════
GUID_A = "11111111-1111-1111-1111-111111111111"
GUID_B = "22222222-2222-2222-2222-222222222222"
CLIENT_ID = "client-id-123"


def _jwt(claims: dict) -> str:
    def b64(obj):
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()
    return f"{b64({'alg': 'RS256'})}.{b64(claims)}.assinatura"


@pytest.mark.parametrize("tenant,claims,email,esperado", [
    # multi-tenant: UPN tem que bater com o e-mail
    ("common", {"aud": CLIENT_ID, "tid": GUID_B, "preferred_username": "vitima@corp.com"}, "vitima@corp.com", None),
    ("common", {"aud": CLIENT_ID, "tid": GUID_B, "preferred_username": "atacante@evil.com"}, "vitima@corp.com", "email_not_verified"),
    ("common", {"aud": CLIENT_ID, "tid": GUID_B}, "vitima@corp.com", "email_not_verified"),
    ("organizations", {"aud": CLIENT_ID, "tid": GUID_B, "preferred_username": "Vitima@Corp.com"}, "vitima@corp.com", None),
    ("consumers", {"aud": CLIENT_ID, "tid": GUID_B, "preferred_username": "x@y.z"}, "vitima@corp.com", "email_not_verified"),
    (None, {"aud": CLIENT_ID, "tid": GUID_B, "preferred_username": "atacante@evil.com"}, "vitima@corp.com", "email_not_verified"),
    # tenant fixo (GUID): tid tem que ser o do tenant
    (GUID_A, {"aud": CLIENT_ID, "tid": GUID_A, "preferred_username": "qualquer@x.com"}, "vitima@corp.com", None),
    (GUID_A.upper(), {"aud": CLIENT_ID, "tid": GUID_A}, "vitima@corp.com", None),
    (GUID_A, {"aud": CLIENT_ID, "tid": GUID_B}, "vitima@corp.com", "tenant_mismatch"),
    # tenant por dominio: o endpoint ja e especifico
    ("corp.onmicrosoft.com", {"aud": CLIENT_ID, "tid": GUID_A}, "vitima@corp.com", None),
    # token invalido
    ("common", None, "vitima@corp.com", "invalid_token"),
    ("common", {"aud": "outro-app", "tid": GUID_A, "preferred_username": "vitima@corp.com"}, "vitima@corp.com", "invalid_token"),
    (GUID_A, {"aud": CLIENT_ID}, "vitima@corp.com", "invalid_token"),
])
def test_microsoft_identity_problem(tenant, claims, email, esperado):
    from app.routers.oauth import microsoft_identity_problem
    assert microsoft_identity_problem(tenant, CLIENT_ID, claims, email) == esperado


def test_decode_jwt_claims():
    from app.routers.oauth import decode_jwt_claims
    assert decode_jwt_claims(_jwt({"tid": "x"}))["tid"] == "x"
    for ruim in (None, "", "a.b", "a.b.c", "a.!!!.c", f"a.{base64.urlsafe_b64encode(b'[1]').decode()}.c"):
        assert decode_jwt_claims(ruim) is None


class _FakeResp:
    def __init__(self, status_code, data):
        self.status_code, self._data = status_code, data

    def json(self):
        return self._data


def _fake_httpx(id_token, userinfo):
    class FakeClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, data=None, **kw):
            body = {"access_token": "AT"}
            if id_token is not None:
                body["id_token"] = id_token
            return _FakeResp(200, body)

        async def get(self, url, headers=None, **kw):
            return _FakeResp(200, userinfo)

    return FakeClient


def _callback(client, monkeypatch, tenant, id_token, userinfo):
    from app.routers import oauth as oauth_router
    monkeypatch.setattr(oauth, "microsoft_config", oauth.ProviderConfig(CLIENT_ID, "sec", "https://x/cb", tenant))
    monkeypatch.setattr(oauth_router.httpx, "AsyncClient", _fake_httpx(id_token, userinfo))
    client.cookies.set("tb45_oauth_state_ms", "abc")
    return client.get("/api/auth/microsoft/callback", params={"state": "abc", "code": "c"})


def _usuario_ms(banco, email, handle="vitima"):
    sql(banco, "INSERT INTO users (username, role, is_local, disabled, created_by, auth_provider, handle, approved_at) "
               "VALUES ($1, 'user', 0, 0, 'microsoft-oauth', 'microsoft', $2, NOW())", email, handle, fetch="exec")


def test_login_microsoft_bloqueia_tenant_do_atacante_com_email_forjado(client, app_env, monkeypatch):
    banco, _ = app_env
    _usuario_ms(banco, "vitima@corp.com")
    # o atacante tem o proprio tenant e colocou o e-mail da vitima no atributo `email`
    token = _jwt({"aud": CLIENT_ID, "tid": GUID_B, "oid": "o1", "preferred_username": "atacante@evil.onmicrosoft.com"})
    r = _callback(client, monkeypatch, "common", token, {"email": "vitima@corp.com"})
    assert r.status_code == 302 and r.headers["location"] == "/login.html?microsoft=error&reason=email_not_verified"
    assert "tb45_session" not in r.headers.get("set-cookie", "")
    assert sql(banco, "SELECT COUNT(*) FROM sessions", fetch="val") == 0


def test_login_microsoft_legitimo_entra(client, app_env, monkeypatch):
    banco, _ = app_env
    _usuario_ms(banco, "vitima@corp.com")
    token = _jwt({"aud": CLIENT_ID, "tid": GUID_A, "oid": "o1", "preferred_username": "vitima@corp.com"})
    r = _callback(client, monkeypatch, "common", token, {"email": "vitima@corp.com"})
    assert r.status_code == 302 and r.headers["location"] == "/login.html?microsoft=success"
    assert "tb45_session=" in r.headers["set-cookie"]
    assert sql(banco, "SELECT COUNT(*) FROM sessions WHERE username = 'vitima@corp.com'", fetch="val") == 1


def test_login_microsoft_tenant_fixo_e_token_invalido(client, app_env, monkeypatch):
    banco, _ = app_env
    _usuario_ms(banco, "vitima@corp.com")
    # tenant fixo, usuario do tenant certo (UPN pode diferir do e-mail)
    ok = _jwt({"aud": CLIENT_ID, "tid": GUID_A, "preferred_username": "vitima@corp.onmicrosoft.com"})
    r = _callback(client, monkeypatch, GUID_A, ok, {"email": "vitima@corp.com"})
    assert r.headers["location"] == "/login.html?microsoft=success"
    # token de outro tenant
    outro = _jwt({"aud": CLIENT_ID, "tid": GUID_B, "preferred_username": "vitima@corp.com"})
    r = _callback(client, monkeypatch, GUID_A, outro, {"email": "vitima@corp.com"})
    assert r.headers["location"] == "/login.html?microsoft=error&reason=tenant_mismatch"
    # sem id_token
    r = _callback(client, monkeypatch, GUID_A, None, {"email": "vitima@corp.com"})
    assert r.headers["location"] == "/login.html?microsoft=error&reason=invalid_token"


def test_login_microsoft_nao_cria_conta_pendente_para_email_forjado(client, app_env, monkeypatch):
    banco, _ = app_env
    token = _jwt({"aud": CLIENT_ID, "tid": GUID_B, "preferred_username": "atacante@evil.com"})
    r = _callback(client, monkeypatch, "common", token, {"email": "ceo@corp.com"})
    assert r.headers["location"].endswith("reason=email_not_verified")
    assert sql(banco, "SELECT COUNT(*) FROM users WHERE username = 'ceo@corp.com'", fetch="val") == 0


# ════════════════════════════════════════════════
# 9) Utilitario de re-sanitizacao do que ja esta no banco
# ════════════════════════════════════════════════
def test_resanitize_lista_e_aplica(client, app_env, monkeypatch):
    banco, _ = app_env
    admin = _admin(client)
    topico = _criar_topico(admin)
    ids = []
    for i in range(2):
        r = admin.post("/api/commands", json=_cmd_payload(name=f"C{i}", topics=[topico], details="<b>ok</b>"))
        assert r.status_code == 201, r.text
        ids.append(r.json()["id"])
    ruim = "<img src=x onerror=alert(1) <b>x</b>"
    sql(banco, "UPDATE commands SET details = $1 WHERE id = $2", ruim, ids[0], fetch="exec")

    from app import resanitize
    n = asyncio.run(resanitize.run(apply=False))
    assert n == 1
    assert sql(banco, "SELECT details FROM commands WHERE id = $1", ids[0], fetch="val") == ruim  # simulacao nao altera
    n = asyncio.run(resanitize.run(apply=True))
    assert n == 1
    limpo = sql(banco, "SELECT details FROM commands WHERE id = $1", ids[0], fetch="val")
    assert not _perigoso(limpo) and "onerror" not in limpo
    assert sql(banco, "SELECT details FROM commands WHERE id = $1", ids[1], fetch="val") == "<b>ok</b>"
    assert asyncio.run(resanitize.run(apply=False)) == 0  # idempotente
