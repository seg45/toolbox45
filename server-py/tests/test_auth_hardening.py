"""Testes dos itens 3 (forca bruta / scrypt travando o event loop) e 9 (sessoes
que nao eram encerradas) da auditoria de seguranca de out/2026. Rodar a partir
de server-py/:

    python -m pytest tests/test_auth_hardening.py -v

Reaproveita as fixtures/helpers de test_security.py (mesmo TestClient unico e
troca de cookie para alternar entre usuarios).
"""
import asyncio
import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_boot import banco, sql  # noqa: E402,F401
from test_security import ADMIN_EMAIL, ADMIN_PASS, app_env, client, _admin, _as, _back_to_admin, _criar_usuario, _token  # noqa: E402,F401

from app import login_guard, security  # noqa: E402
from app.login_guard import FailureLimiter  # noqa: E402


@pytest.fixture(autouse=True)
def _limpa_limitadores():
    login_guard.login_limiter.reset()
    login_guard.password_change_limiter.reset()
    yield
    login_guard.login_limiter.reset()
    login_guard.password_change_limiter.reset()


def _tentar(client, user, senha, ip=None):
    headers = {"X-Real-IP": ip} if ip else {}
    return client.post("/api/auth/login", json={"username": user, "password": senha}, headers=headers)


# ════════════════════════════════════════════════
# 3) Limitador de falhas (unitario, sem banco)
# ════════════════════════════════════════════════
class _Relogio:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


@pytest.fixture
def relogio(monkeypatch):
    r = _Relogio()
    monkeypatch.setattr(login_guard.time, "monotonic", r)
    return r


def test_limitador_bloqueia_apos_n_falhas_e_libera_com_a_janela(relogio):
    lim = FailureLimiter(per_user_ip=3, per_user=100, per_ip=100, window=60)
    for _ in range(2):
        lim.record_failure("1.1.1.1", "ana")
    assert lim.retry_after("1.1.1.1", "ana") == 0
    lim.record_failure("1.1.1.1", "ana")
    espera = lim.retry_after("1.1.1.1", "ana")
    assert 55 <= espera <= 61
    relogio.t += 30
    assert 25 <= lim.retry_after("1.1.1.1", "ana") <= 31
    relogio.t += 31
    assert lim.retry_after("1.1.1.1", "ana") == 0


def test_limitador_dimensoes_independentes(relogio):
    lim = FailureLimiter(per_user_ip=2, per_user=4, per_ip=5, window=60)
    # (IP, usuario): outro IP e outro usuario seguem livres
    lim.record_failure("1.1.1.1", "ana"); lim.record_failure("1.1.1.1", "ana")
    assert lim.retry_after("1.1.1.1", "ana") > 0
    assert lim.retry_after("2.2.2.2", "ana") == 0
    assert lim.retry_after("1.1.1.1", "bia") == 0
    # por usuario: ataque distribuido (IPs diferentes) a mesma conta
    lim.reset()
    for ip in ("1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4"):
        lim.record_failure(ip, "ana")
    assert lim.retry_after("9.9.9.9", "ana") > 0
    assert lim.retry_after("9.9.9.9", "bia") == 0
    # por IP: password spraying (uma senha em varias contas)
    lim.reset()
    for u in ("a", "b", "c", "d", "e"):
        lim.record_failure("7.7.7.7", u)
    assert lim.retry_after("7.7.7.7", "qualquer") > 0
    assert lim.retry_after("8.8.8.8", "qualquer") == 0


def test_limitador_sucesso_limpa_ip_usuario_e_normaliza_nome(relogio):
    lim = FailureLimiter(per_user_ip=3, per_user=100, per_ip=100, window=60)
    lim.record_failure("1.1.1.1", "Ana"); lim.record_failure("1.1.1.1", " ana ")
    lim.record_success("1.1.1.1", "ANA")
    lim.record_failure("1.1.1.1", "ana")
    assert lim.retry_after("1.1.1.1", "ana") == 0  # contador recomecou
    for _ in range(3):
        lim.record_failure("1.1.1.1", "Ana ")
    assert lim.retry_after("1.1.1.1", "ANA") > 0  # maiusculas/espacos nao burlam


def test_limitador_nao_estende_bloqueio_e_tem_memoria_limitada(relogio, monkeypatch):
    lim = FailureLimiter(per_user_ip=2, per_user=100, per_ip=100, window=60)
    lim.record_failure("1.1.1.1", "ana"); lim.record_failure("1.1.1.1", "ana")
    antes = lim.retry_after("1.1.1.1", "ana")
    for _ in range(50):          # tentativas bloqueadas nem sao registradas pela rota,
        lim.retry_after("1.1.1.1", "ana")  # e consultar nao altera o estado
    assert lim.retry_after("1.1.1.1", "ana") == antes
    monkeypatch.setattr(login_guard, "MAX_KEYS", 200)
    lim2 = FailureLimiter(per_user_ip=5, per_user=20, per_ip=30, window=60)
    for i in range(2000):
        lim2.record_failure(f"10.0.{i // 250}.{i % 250}", f"user{i}")
        relogio.t += 0.001
    assert len(lim2._hits) < 400


# ════════════════════════════════════════════════
# 3) Login ponta a ponta
# ════════════════════════════════════════════════
def test_login_bloqueia_apos_5_erros_com_429_e_retry_after(client):
    admin = _admin(client)
    _criar_usuario(admin, "alvo@x.com", "senha-forte-1")
    _as(client, None)
    for _ in range(5):
        assert _tentar(client, "alvo@x.com", "errada").status_code == 401
    r = _tentar(client, "alvo@x.com", "errada")
    assert r.status_code == 429
    assert r.json()["error"] == "too_many_attempts"
    assert int(r.headers["retry-after"]) > 0
    # a senha CERTA tambem fica bloqueada enquanto durar o bloqueio
    assert _tentar(client, "alvo@x.com", "senha-forte-1").status_code == 429
    # outra conta, do mesmo IP, continua livre; e a mesma conta de outro IP tambem
    assert _tentar(client, ADMIN_EMAIL, ADMIN_PASS).status_code == 200
    assert _tentar(client, "alvo@x.com", "senha-forte-1", ip="203.0.113.9").status_code == 200


def test_login_bloqueado_nao_calcula_scrypt_e_inexistente_calcula(client, monkeypatch):
    chamadas = []
    real = security.verify_password

    def contador(*a, **k):
        chamadas.append(1)
        return real(*a, **k)

    monkeypatch.setattr(security, "verify_password", contador)
    _as(client, None)
    # usuario que nao existe: ainda assim 1 scrypt (tempo de resposta uniforme)
    assert _tentar(client, "fantasma@x.com", "qualquer").status_code == 401
    assert len(chamadas) == 1
    for _ in range(4):
        _tentar(client, "fantasma@x.com", "qualquer")
    n = len(chamadas)
    assert _tentar(client, "fantasma@x.com", "qualquer").status_code == 429
    assert len(chamadas) == n  # bloqueado: zero scrypt


def test_login_sucesso_zera_contador_do_ip_usuario(client):
    _as(client, None)
    for _ in range(4):
        assert _tentar(client, ADMIN_EMAIL, "errada").status_code == 401
    assert _tentar(client, ADMIN_EMAIL, ADMIN_PASS).status_code == 200
    for _ in range(4):
        assert _tentar(client, ADMIN_EMAIL, "errada").status_code == 401  # nao bloqueou: zerou no sucesso


def test_scrypt_roda_fora_da_thread_do_event_loop_e_com_concorrencia_limitada(monkeypatch):
    principal = threading.get_ident()
    threads, vivos, pico = set(), [0], [0]
    trava = threading.Lock()

    def falso(password, stored):
        with trava:
            vivos[0] += 1
            pico[0] = max(pico[0], vivos[0])
            threads.add(threading.get_ident())
        time.sleep(0.05)
        with trava:
            vivos[0] -= 1
        return True

    monkeypatch.setattr(security, "verify_password", falso)

    async def rodar():
        return await asyncio.gather(*[security.verify_password_async("x", "y") for _ in range(8)])

    assert all(asyncio.run(rodar()))
    assert principal not in threads
    assert pico[0] <= security.SCRYPT_CONCURRENCY


def test_event_loop_continua_respondendo_durante_hash_real():
    async def rodar():
        maior, parar = [0.0], [False]

        async def pulso():
            ultimo = time.monotonic()
            while not parar[0]:
                await asyncio.sleep(0.005)
                agora = time.monotonic()
                maior[0] = max(maior[0], agora - ultimo)
                ultimo = agora

        t = asyncio.create_task(pulso())
        await asyncio.sleep(0.02)
        await asyncio.gather(*[security.hash_password_async("senha-de-teste") for _ in range(4)])
        parar[0] = True
        await t
        return maior[0]

    # um scrypt sincrono segura o loop por dezenas de ms; em thread o "pulso" segue em dia
    assert asyncio.run(rodar()) < 0.05


def test_fila_de_hash_cheia_responde_503(client, monkeypatch):
    _as(client, None)
    monkeypatch.setattr(security, "MAX_PENDING", 0)
    r = _tentar(client, ADMIN_EMAIL, ADMIN_PASS)
    assert r.status_code == 503
    assert r.json()["error"] == "server_busy"
    assert r.headers["retry-after"] == "5"


# ════════════════════════════════════════════════
# 3) Troca de senha logado: adivinhar a senha atual tambem e limitado
# ════════════════════════════════════════════════
def test_troca_de_senha_limita_tentativas_da_senha_atual(client):
    admin = _admin(client)
    _criar_usuario(admin, "troca@x.com", "senha-forte-1")
    tk = _token(client, "troca@x.com", "senha-forte-1")
    _as(client, tk)
    for _ in range(5):
        r = client.put("/api/me/password", json={"current_password": "errada", "new_password": "nova-senha-9"})
        assert r.status_code == 401
    r = client.put("/api/me/password", json={"current_password": "senha-forte-1", "new_password": "nova-senha-9"})
    assert r.status_code == 429 and r.json()["error"] == "too_many_attempts"


# ════════════════════════════════════════════════
# 10 (resto) Senha minima tambem na troca pelo proprio usuario
# ════════════════════════════════════════════════
def test_troca_de_senha_exige_minimo_de_8(client):
    admin = _admin(client)
    _criar_usuario(admin, "curta@x.com", "senha-forte-1")
    _as(client, _token(client, "curta@x.com", "senha-forte-1"))
    r = client.put("/api/me/password", json={"current_password": "senha-forte-1", "new_password": "1234"})
    assert r.status_code == 400 and "new_password" in r.json()["message"] and "8" in r.json()["message"]
    r = client.put("/api/me/password", json={"current_password": "senha-forte-1", "new_password": "x" * 300})
    assert r.status_code == 400


# ════════════════════════════════════════════════
# 9) Sessoes
# ════════════════════════════════════════════════
def _login_novo(client, user, senha):
    """Novo login (nova sessao) -- limpa o cookie antes para nao conflitar com o anterior."""
    _as(client, None)
    return _token(client, user, senha)


def _vale(client, token):
    _as(client, token)
    return client.get("/api/me").status_code == 200


def test_troca_de_senha_encerra_as_outras_sessoes_e_mantem_a_atual(client):
    admin = _admin(client)
    _criar_usuario(admin, "dona@x.com", "senha-forte-1")
    atual = _login_novo(client, "dona@x.com", "senha-forte-1")
    outra = _login_novo(client, "dona@x.com", "senha-forte-1")   # ex.: cookie roubado / outro PC
    assert _vale(client, atual) and _vale(client, outra)
    _as(client, atual)
    r = client.put("/api/me/password", json={"current_password": "senha-forte-1", "new_password": "outra-senha-77"})
    assert r.status_code == 204, r.text
    assert _vale(client, atual)
    assert not _vale(client, outra)
    _as(client, None)
    assert _tentar(client, "dona@x.com", "senha-forte-1").status_code == 401
    assert _tentar(client, "dona@x.com", "outra-senha-77").status_code == 200


def test_reset_de_senha_pelo_admin_encerra_todas_as_sessoes_do_usuario(client, app_env):
    banco, _ = app_env
    admin = _admin(client)
    _criar_usuario(admin, "reset@x.com", "senha-forte-1")
    s1 = _login_novo(client, "reset@x.com", "senha-forte-1")
    s2 = _login_novo(client, "reset@x.com", "senha-forte-1")
    _back_to_admin(client)
    r = client.put("/api/users/reset@x.com", json={"password": "senha-nova-123"})
    assert r.status_code == 200, r.text
    assert not _vale(client, s1) and not _vale(client, s2)
    _back_to_admin(client)
    assert sql(banco, "SELECT COUNT(*) FROM sessions WHERE username = 'reset@x.com'", fetch="val") == 0
    detalhe = sql(banco, "SELECT details FROM audit_log WHERE entity_id = 'reset@x.com' AND action = 'update' ORDER BY id DESC LIMIT 1", fetch="val")
    assert "password" in detalhe and "2 session(s) revoked" in detalhe
    assert _vale(client, _login_novo(client, "reset@x.com", "senha-nova-123"))


def test_desativar_usuario_encerra_sessoes_e_reativar_nao_as_revive(client):
    admin = _admin(client)
    _criar_usuario(admin, "off@x.com", "senha-forte-1")
    s = _login_novo(client, "off@x.com", "senha-forte-1")
    _back_to_admin(client)
    assert client.put("/api/users/off@x.com", json={"disabled": True}).status_code == 200
    assert not _vale(client, s)
    _back_to_admin(client)
    assert client.put("/api/users/off@x.com", json={"disabled": False}).status_code == 200
    assert not _vale(client, s)  # a sessao antiga morreu de vez; precisa logar de novo
    assert _vale(client, _login_novo(client, "off@x.com", "senha-forte-1"))


def test_mudar_so_o_role_nao_derruba_a_sessao(client):
    admin = _admin(client)
    _criar_usuario(admin, "role@x.com", "senha-forte-1")
    s = _login_novo(client, "role@x.com", "senha-forte-1")
    _back_to_admin(client)
    assert client.put("/api/users/role@x.com", json={"role": "admin"}).status_code == 200
    assert _vale(client, s)


def test_limite_de_sessoes_por_usuario_descarta_as_mais_antigas(client, app_env):
    from app import session as sess
    banco, _ = app_env
    admin = _admin(client)
    _criar_usuario(admin, "muitas@x.com", "senha-forte-1")
    tokens = [_login_novo(client, "muitas@x.com", "senha-forte-1") for _ in range(sess.MAX_SESSIONS_PER_USER + 3)]
    assert sql(banco, "SELECT COUNT(*) FROM sessions WHERE username = 'muitas@x.com'", fetch="val") == sess.MAX_SESSIONS_PER_USER
    assert not _vale(client, tokens[0])
    assert _vale(client, tokens[-1])


def test_sessoes_vencidas_saem_da_tabela_no_proximo_login(client, app_env):
    banco, _ = app_env
    admin = _admin(client)
    _criar_usuario(admin, "velha@x.com", "senha-forte-1")
    sql(banco, "INSERT INTO sessions (token, username, expires_at) VALUES ('expirada1', 'velha@x.com', NOW() - INTERVAL '1 day')", fetch="exec")
    _as(client, None)
    _login = _tentar(client, ADMIN_EMAIL, ADMIN_PASS)
    assert _login.status_code == 200
    assert sql(banco, "SELECT COUNT(*) FROM sessions WHERE token = 'expirada1'", fetch="val") == 0
