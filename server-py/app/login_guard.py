"""Limite de tentativas FALHAS de senha (login e troca de senha).

Complementa o `limit_req` do nginx (que conta toda requisicao por IP): aqui
so contam as tentativas que ERRARAM a senha, em tres dimensoes, numa janela
deslizante:

  * (IP, usuario)  -- freia quem insiste numa conta a partir de um lugar;
  * usuario        -- freia um ataque distribuido (varios IPs) a uma conta;
  * IP             -- freia "password spraying" (uma senha em muitas contas).

Estourou o limite -> 429 com Retry-After ate a janela liberar. Enquanto bloqueado
NAO e calculado scrypt (rejeicao barata: nao da pra gastar CPU do servidor
batendo num login bloqueado) e a tentativa bloqueada nao conta como nova falha
(o bloqueio termina em hora certa, nao se estende sozinho).

Compromisso conhecido: o limite por usuario permite que um atacante deixe uma
conta indisponivel por ate WINDOW_SECONDS ao errar de proposito. Por isso o
limite por usuario e bem mais alto que o por (IP, usuario) e o bloqueio nunca
passa de 15 min; um login correto limpa o contador do (IP, usuario).

O estado fica em memoria (um unico processo uvicorn -- ver Dockerfile): reiniciar
o backend zera os contadores. As estruturas sao limitadas (MAX_KEYS) para que
uma enxurrada de usernames inventados nao consuma memoria sem fim.
"""
import time
from collections import deque
from typing import Deque, Dict, Optional, Tuple

WINDOW_SECONDS = 15 * 60
MAX_KEYS = 20000
_KEY_MAX_LEN = 128


class FailureLimiter:
    def __init__(self, per_user_ip: int, per_user: int, per_ip: int, window: int = WINDOW_SECONDS) -> None:
        self.limits = {"uip": per_user_ip, "u": per_user, "ip": per_ip}
        self.window = window
        self._hits: Dict[Tuple[str, str], Deque[float]] = {}

    @staticmethod
    def _norm(value: Optional[str]) -> str:
        return (value or "").strip().lower()[:_KEY_MAX_LEN]

    def _keys(self, ip: str, username: str):
        ip, user = self._norm(ip) or "?", self._norm(username)
        return (("uip", f"{ip}|{user}"), ("u", user), ("ip", ip))

    def _prune(self, dq: Deque[float], now: float) -> None:
        cutoff = now - self.window
        while dq and dq[0] <= cutoff:
            dq.popleft()

    def retry_after(self, ip: str, username: str) -> int:
        """Segundos ate poder tentar de novo (0 = liberado)."""
        now = time.monotonic()
        wait = 0.0
        for kind, key in self._keys(ip, username):
            dq = self._hits.get((kind, key))
            if not dq:
                continue
            self._prune(dq, now)
            limit = self.limits[kind]
            if len(dq) >= limit:
                # libera quando a falha numero (len - limit + 1) sair da janela
                wait = max(wait, dq[len(dq) - limit] + self.window - now)
        return int(wait) + 1 if wait > 0 else 0

    def record_failure(self, ip: str, username: str) -> None:
        now = time.monotonic()
        if len(self._hits) >= MAX_KEYS:
            self._purge(now)
        for kind, key in self._keys(ip, username):
            if kind == "u" and not key:
                continue
            self._hits.setdefault((kind, key), deque()).append(now)

    def record_success(self, ip: str, username: str) -> None:
        self._hits.pop(("uip", f"{self._norm(ip) or '?'}|{self._norm(username)}"), None)

    def _purge(self, now: float) -> None:
        for k in [k for k, dq in self._hits.items() if not dq or dq[-1] <= now - self.window]:
            self._hits.pop(k, None)
        # ainda cheio (ataque em andamento): descarta as chaves mais antigas
        if len(self._hits) >= MAX_KEYS:
            for k, _ in sorted(self._hits.items(), key=lambda kv: kv[1][-1])[: MAX_KEYS // 4]:
                self._hits.pop(k, None)

    def reset(self) -> None:
        self._hits.clear()


# Login: 5 erros por (IP, usuario), 20 por usuario, 30 por IP em 15 min.
login_limiter = FailureLimiter(per_user_ip=5, per_user=20, per_ip=30)
# Troca de senha logado (adivinhar a senha atual com uma sessao roubada).
password_change_limiter = FailureLimiter(per_user_ip=5, per_user=10, per_ip=30)


def client_ip(request) -> str:
    """IP do cliente. O backend so e alcancavel pelo nginx (compose sem `ports:`
    para ele), que SEMPRE sobrescreve X-Real-IP com $remote_addr; sem o
    cabecalho (testes/acesso direto) vale o IP da conexao."""
    real = request.headers.get("x-real-ip", "").strip()
    if real:
        return real[:64]
    return request.client.host if request.client else "?"
