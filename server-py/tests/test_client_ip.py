"""Item 1 da fase 2 da auditoria (out/2026): quando o Docker entrega as conexoes
com o IP do gateway da rede (docker-proxy), todos os usuarios chegam com o mesmo
IP. O limitador de login nao pode tratar isso como UM cliente (bloquearia todo
mundo): usa so o limite por usuario. Nao precisa de PostgreSQL.

    python -m pytest tests/test_client_ip.py -v
"""
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import login_guard  # noqa: E402
from app.login_guard import SHARED_SOURCE, FailureLimiter, client_ip  # noqa: E402


def _req(real=None, peer="172.18.0.4"):
    headers = {"x-real-ip": real} if real is not None else {}
    return SimpleNamespace(headers=headers, client=SimpleNamespace(host=peer) if peer else None)


@pytest.mark.parametrize("real,peer,esperado", [
    ("172.18.0.1", "172.18.0.4", SHARED_SOURCE),     # gateway da bridge do compose
    ("172.18.5.9", "172.18.0.4", SHARED_SOURCE),     # mesma /16
    ("192.168.16.1", "192.168.16.3", SHARED_SOURCE), # outro pool do Docker
    ("203.0.113.7", "172.18.0.4", "203.0.113.7"),    # IP real publico preservado
    ("10.20.30.40", "172.18.0.4", "10.20.30.40"),    # cliente da LAN preservado
    ("172.19.0.1", "172.18.0.4", "172.19.0.1"),      # outra rede, nao e o gateway deste nginx
    ("2001:db8::1", "172.18.0.4", "2001:db8::1"),    # IPv6 real preservado
    ("lixo", "172.18.0.4", "lixo"),                  # nao e IP: vale como veio (nao quebra)
])
def test_client_ip(real, peer, esperado):
    assert client_ip(_req(real, peer)) == esperado


def test_sem_cabecalho_vale_o_ip_da_conexao():
    assert client_ip(_req(None, "198.51.100.5")) == "198.51.100.5"
    assert client_ip(_req(None, None)) == "?"
    assert client_ip(_req("", "testclient")) == "testclient"   # TestClient do Starlette


def test_x_real_ip_gigante_e_cortado():
    assert len(client_ip(_req("1" * 500, "203.0.113.1"))) <= 64


def test_limitador_so_por_usuario_na_origem_compartilhada():
    lim = FailureLimiter(per_user_ip=5, per_user=20, per_ip=30)
    # 29 falhas de varias contas pela origem compartilhada NAO bloqueiam outra conta
    for i in range(29):
        lim.record_failure(SHARED_SOURCE, f"alvo{i}@x.com")
    assert lim.retry_after(SHARED_SOURCE, "inocente@x.com") == 0
    # 5 falhas na MESMA conta nao bloqueiam (o limite por (IP, usuario) nao vale aqui)...
    for _ in range(5):
        lim.record_failure(SHARED_SOURCE, "vitima@x.com")
    assert lim.retry_after(SHARED_SOURCE, "vitima@x.com") == 0
    # ...mas 20 sim (limite por usuario), e so aquela conta
    for _ in range(15):
        lim.record_failure(SHARED_SOURCE, "vitima@x.com")
    assert lim.retry_after(SHARED_SOURCE, "vitima@x.com") > 0
    assert lim.retry_after(SHARED_SOURCE, "inocente@x.com") == 0


def test_ip_real_continua_com_os_tres_limites():
    lim = FailureLimiter(per_user_ip=5, per_user=20, per_ip=30)
    for _ in range(5):
        lim.record_failure("203.0.113.7", "a@x.com")
    assert lim.retry_after("203.0.113.7", "a@x.com") > 0
    assert lim.retry_after("203.0.113.8", "a@x.com") == 0   # outro IP, mesma conta: ainda livre
    for i in range(30):
        lim.record_failure("198.51.100.9", f"u{i}@x.com")
    assert lim.retry_after("198.51.100.9", "novo@x.com") > 0   # spraying por IP


def test_aviso_so_uma_vez(caplog):
    login_guard._warned_shared = False
    with caplog.at_level("WARNING", logger="toolbox45.login_guard"):
        for _ in range(3):
            client_ip(_req("172.18.0.1", "172.18.0.4"))
    assert sum("userland-proxy" in r.message for r in caplog.records) == 1
