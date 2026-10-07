"""Configuracao inicial (primeiro acesso): sem conta admin/admin, o primeiro
super_admin nasce em POST /api/auth/setup; uma instalacao antiga com admin/admin
e convertida. Rodar a partir de server-py/:

    python -m pytest tests/test_setup.py -v
"""
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_boot import banco, boot, sql  # noqa: E402,F401
from test_security import app_env  # noqa: E402,F401

from app import login_guard, setup  # noqa: E402
from app.security import hash_password  # noqa: E402

EMAIL = "dono@empresa.com"
SENHA = "senha-do-dono-1"


@pytest.fixture(autouse=True)
def _limpa_limitadores():
    login_guard.login_limiter.reset()
    yield
    login_guard.login_limiter.reset()


def _app_client():
    from fastapi.testclient import TestClient
    from app.main import app
    return TestClient(app, follow_redirects=False)


@pytest.fixture
def novo(app_env):
    """Instalacao nova (banco vazio): ninguem existe ainda."""
    with _app_client() as c:
        yield c


def _setup(c, email=EMAIL, senha=SENHA, **kw):
    return c.post("/api/auth/setup", json={"email": email, "password": senha}, **kw)


# ════════════════════════════════════════════════
# Instalacao nova
# ════════════════════════════════════════════════
def test_instalacao_nova_pede_configuracao_e_nao_tem_admin_padrao(novo, app_env):
    banco, _ = app_env
    assert novo.get("/api/auth/setup-status").json() == {"required": True, "mode": "fresh"}
    assert sql(banco, "SELECT COUNT(*) FROM users", fetch="val") == 0
    r = novo.post("/api/auth/login", json={"username": "admin", "password": "admin"})
    assert r.status_code == 401  # a conta padrao NAO existe


@pytest.mark.parametrize("email,senha,trecho", [
    ("", SENHA, "e-mail"),
    ("sem-arroba", SENHA, "e-mail"),
    ("a@b", SENHA, "e-mail"),
    (EMAIL, "", "password"),
    (EMAIL, "curta", "8"),
    (EMAIL, "x" * 300, "256"),
    (EMAIL, EMAIL, "same"),
])
def test_setup_valida_email_e_senha(novo, app_env, email, senha, trecho):
    banco, _ = app_env
    r = _setup(novo, email, senha)
    assert r.status_code == 400 and r.json()["error"] == "validation_error"
    assert trecho in r.json()["message"].lower() or trecho in r.json()["message"]
    assert sql(banco, "SELECT COUNT(*) FROM users", fetch="val") == 0
    assert novo.get("/api/auth/setup-status").json()["required"] is True


def test_setup_cria_super_admin_abre_sessao_e_fecha_a_tela(novo, app_env):
    banco, _ = app_env
    r = _setup(novo, "  Dono@Empresa.com ")
    assert r.status_code == 200, r.text
    assert r.json() == {"username": EMAIL, "role": "super_admin", "mode": "fresh"}
    assert "tb45_session" in novo.cookies and "secure" not in r.headers["set-cookie"].lower()

    u = sql(banco, "SELECT * FROM users WHERE username = $1", EMAIL, fetch="row")
    assert u["role"] == "super_admin" and u["is_local"] == 1 and u["disabled"] == 0
    assert u["created_by"] == "setup" and u["approved_at"] is not None
    assert sql(banco, "SELECT COUNT(*) FROM folders WHERE username = $1 AND name = 'Favorites'", EMAIL, fetch="val") == 1
    assert sql(banco, "SELECT COUNT(*) FROM audit_log WHERE username = $1 AND details LIKE 'Initial setup%'", EMAIL, fetch="val") == 1
    assert sql(banco, "SELECT COUNT(*) FROM users WHERE username = 'admin'", fetch="val") == 0

    me = novo.get("/api/me")
    assert me.status_code == 200 and me.json()["role"] == "super_admin"
    assert novo.get("/api/auth/setup-status").json() == {"required": False, "mode": None}
    # e a tela nunca mais funciona
    novo.cookies.clear()
    r2 = _setup(novo, "outro@empresa.com")
    assert r2.status_code == 409 and r2.json()["error"] == "setup_not_required"
    assert sql(banco, "SELECT COUNT(*) FROM users", fetch="val") == 1
    # a senha vale no login normal
    assert novo.post("/api/auth/login", json={"username": EMAIL, "password": SENHA}).status_code == 200


def test_setup_atras_do_proxy_https_marca_o_cookie_secure(novo):
    r = _setup(novo, headers={"X-Forwarded-Proto": "https"})
    assert r.status_code == 200 and "secure" in r.headers["set-cookie"].lower()


def test_setup_recusa_email_ja_cadastrado_antes_da_configuracao(novo, app_env):
    banco, _ = app_env
    assert novo.post("/api/auth/register", json={"email": EMAIL, "password": SENHA}).status_code == 201
    r = _setup(novo)
    assert r.status_code == 409 and r.json()["error"] == "conflict"
    assert sql(banco, "SELECT role FROM users WHERE username = $1", EMAIL, fetch="val") == "user"  # nao foi promovido
    assert _setup(novo, "outro@empresa.com").status_code == 200  # com outro e-mail funciona


def test_duas_configuracoes_simultaneas_so_uma_vence(novo, app_env):
    banco, _ = app_env
    resultados = []

    def disparar(email):
        resultados.append(_setup(novo, email).status_code)

    ts = [threading.Thread(target=disparar, args=(f"p{i}@empresa.com",)) for i in range(4)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert sorted(resultados) == [200, 409, 409, 409], resultados
    assert sql(banco, "SELECT COUNT(*) FROM users WHERE role = 'super_admin'", fetch="val") == 1


# ════════════════════════════════════════════════
# Instalacao antiga: admin/admin e convertido
# ════════════════════════════════════════════════
def _popular_legado(banco, senha_admin):
    boot()  # schema + migracoes + seeds (sem admin)
    sql(banco, """INSERT INTO users (username, password_hash, role, is_local, created_by, auth_provider, approved_at)
                  VALUES ('admin', $1, 'super_admin', 1, 'system', 'local', NOW()),
                         ('ana@x.com', $2, 'user', 1, 'admin', 'local', NOW())""",
        hash_password(senha_admin), hash_password("senha-da-ana-1"), fetch="exec")
    sql(banco, """
        INSERT INTO folders (username, name) VALUES ('admin', 'Favorites'), ('admin', 'Pasta do admin'), ('ana@x.com', 'Favorites');
        INSERT INTO commands (topic, name, created_by, modified_by) VALUES ('t1', 'cmd do admin', 'admin', 'admin');
        INSERT INTO user_favorites (username, command_id) SELECT 'admin', id FROM commands LIMIT 1;
        INSERT INTO user_data (username, data_key, value) VALUES ('admin', 'tema', 'dark');
        INSERT INTO links (username, name, url) VALUES ('admin', 'Wiki', 'https://wiki.local');
        INSERT INTO audit_log (username, action, entity_type, entity_id) VALUES ('admin', 'create', 'command', 'x');
        INSERT INTO api_keys (name, key_prefix, key_hash, created_by) VALUES ('robo', 'tb45_ab', 'hash-unico-1', 'admin');
        INSERT INTO groups (name, created_by) VALUES ('Suporte', 'admin');
        INSERT INTO group_members (group_id, username) SELECT id, 'admin' FROM groups WHERE name = 'Suporte';
        INSERT INTO shares (grantor_username, grantee_username, share_folders) VALUES ('admin', 'ana@x.com', true), ('ana@x.com', 'admin', true);
        INSERT INTO sessions (token, username, expires_at) VALUES ('sessao-antiga', 'admin', NOW() + INTERVAL '1 day');
    """, fetch="exec")
    sql(banco, "INSERT INTO notes (folder_id, username, title) SELECT id, 'admin', 'n1' FROM folders WHERE username = 'admin' AND name = 'Pasta do admin'", fetch="exec")
    sql(banco, "INSERT INTO oauth_settings (provider, updated_by) VALUES ('google', 'admin') ON CONFLICT (provider) DO UPDATE SET updated_by = 'admin'", fetch="exec")
    sql(banco, "INSERT INTO system_logo (id, updated_by, updated_by_dark) VALUES (1, 'admin', 'admin') ON CONFLICT (id) DO UPDATE SET updated_by = 'admin', updated_by_dark = 'admin'", fetch="exec")


@pytest.fixture
def legado(app_env):
    banco, _ = app_env
    _popular_legado(banco, "admin")
    with _app_client() as c:
        yield c


def test_instalacao_antiga_com_senha_padrao_exige_configuracao_e_bloqueia_o_login(legado, app_env):
    banco, _ = app_env
    assert legado.get("/api/auth/setup-status").json() == {"required": True, "mode": "migrate"}
    for senha in ("admin", "qualquer-outra"):
        r = legado.post("/api/auth/login", json={"username": "admin", "password": senha})
        assert r.status_code == 403 and r.json()["error"] == "setup_required"
    assert sql(banco, "SELECT COUNT(*) FROM sessions WHERE username = 'admin' AND token <> 'sessao-antiga'", fetch="val") == 0
    # outras contas continuam entrando
    assert legado.post("/api/auth/login", json={"username": "ana@x.com", "password": "senha-da-ana-1"}).status_code == 200


def test_migracao_move_tudo_do_admin_para_o_email_novo(legado, app_env):
    banco, _ = app_env
    r = _setup(legado)
    assert r.status_code == 200, r.text
    assert r.json() == {"username": EMAIL, "role": "super_admin", "mode": "migrate"}

    assert sql(banco, "SELECT COUNT(*) FROM users WHERE username = 'admin'", fetch="val") == 0
    for tabela, coluna in setup.USERNAME_REFERENCES:
        assert sql(banco, f"SELECT COUNT(*) FROM {tabela} WHERE {coluna} = 'admin'", fetch="val") == 0, (tabela, coluna)
    contagens = {
        "folders": ("username", 2), "commands": ("created_by", 1), "user_favorites": ("username", 1),
        "user_data": ("username", 1), "links": ("username", 1), "notes": ("username", 1),
        "api_keys": ("created_by", 1), "groups": ("created_by", 1), "group_members": ("username", 1),
        "oauth_settings": ("updated_by", 1), "system_logo": ("updated_by", 1),
    }
    for tabela, (coluna, esperado) in contagens.items():
        assert sql(banco, f"SELECT COUNT(*) FROM {tabela} WHERE {coluna} = $1", EMAIL, fetch="val") == esperado, tabela
    assert sql(banco, "SELECT COUNT(*) FROM shares WHERE grantor_username = $1 AND grantee_username = 'ana@x.com'", EMAIL, fetch="val") == 1
    assert sql(banco, "SELECT COUNT(*) FROM shares WHERE grantor_username = 'ana@x.com' AND grantee_username = $1", EMAIL, fetch="val") == 1
    assert sql(banco, "SELECT created_by FROM users WHERE username = 'ana@x.com'", fetch="val") == EMAIL
    assert sql(banco, "SELECT COUNT(*) FROM sessions WHERE token = 'sessao-antiga'", fetch="val") == 0  # sessao do admin extinta
    assert sql(banco, "SELECT COUNT(*) FROM folders WHERE username = $1 AND name = 'Favorites'", EMAIL, fetch="val") == 1  # sem duplicar

    me = legado.get("/api/me")
    assert me.status_code == 200 and me.json()["role"] == "super_admin"
    assert legado.get("/api/auth/setup-status").json() == {"required": False, "mode": None}
    legado.cookies.clear()
    assert legado.post("/api/auth/login", json={"username": "admin", "password": "admin"}).status_code == 401
    assert legado.post("/api/auth/login", json={"username": EMAIL, "password": SENHA}).status_code == 200


def test_migracao_recusa_email_de_outra_conta_e_nao_altera_nada(legado, app_env):
    banco, _ = app_env
    r = _setup(legado, "ana@x.com")
    assert r.status_code == 409 and r.json()["error"] == "conflict"
    assert sql(banco, "SELECT COUNT(*) FROM users WHERE username = 'admin'", fetch="val") == 1
    assert sql(banco, "SELECT COUNT(*) FROM folders WHERE username = 'admin'", fetch="val") == 2
    assert legado.get("/api/auth/setup-status").json()["mode"] == "migrate"


def test_admin_legado_com_senha_trocada_nao_pede_configuracao(app_env):
    banco, _ = app_env
    _popular_legado(banco, "uma-senha-que-o-dono-escolheu")
    with _app_client() as c:
        assert c.get("/api/auth/setup-status").json() == {"required": False, "mode": None}
        assert _setup(c).status_code == 409
        r = c.post("/api/auth/login", json={"username": "admin", "password": "uma-senha-que-o-dono-escolheu"})
        assert r.status_code == 200 and r.json()["role"] == "super_admin"


# ════════════════════════════════════════════════
# A lista de colunas a migrar cobre o schema inteiro
# ════════════════════════════════════════════════
def test_lista_de_referencias_a_usuarios_cobre_todo_o_schema(banco):
    boot()
    candidatas = {
        (r["table_name"], r["column_name"])
        for r in sql(banco, """SELECT table_name, column_name FROM information_schema.columns
                               WHERE table_schema = 'public'
                                 AND (column_name IN ('username', 'grantor_username', 'grantee_username')
                                      OR column_name LIKE '%\\_by' OR column_name LIKE '%\\_by\\_dark')""")
    }
    candidatas.discard(("users", "username"))  # a propria chave primaria
    assert candidatas == set(setup.USERNAME_REFERENCES), (
        "colunas do schema que referenciam usuarios mas nao estao em setup.USERNAME_REFERENCES (ou vice-versa): "
        f"{candidatas ^ set(setup.USERNAME_REFERENCES)}"
    )
