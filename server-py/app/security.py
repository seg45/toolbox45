"""Hash de senha (scrypt) e geracao de token de sessao -- porta exata de
server/auth.js, pra manter compatibilidade de login com os usuarios locais
ja cadastrados.

ARMADILHA ENCONTRADA E CORRIGIDA (validada com um hash gerado pelo Node de
verdade nesta maquina antes de qualquer teste em producao): em
server/auth.js, `crypto.scryptSync(String(password), salt, 64)` recebe
`salt` como uma STRING (os 16 bytes aleatorios de crypto.randomBytes(16) ja
convertidos pra hex, 32 caracteres) -- e o Node, quando `salt` e uma string
(nao um Buffer), trata ela como texto puro codificado em UTF-8, e NAO
decodifica de volta pros 16 bytes originais que aquele hex representa. Ou
seja: a string hex de 32 caracteres em si (32 bytes em UTF-8) E o salt
usado pelo KDF -- os "16 bytes originais" nunca sao reconstituidos nem
usados diretamente em lugar nenhum depois de virarem hex.

Por isso aqui em baixo NUNCA se faz `bytes.fromhex(salt_hex)` pra obter o
salt -- isso geraria um salt DIFERENTE do que o Node realmente usou, e
verify_password() falharia silenciosamente pra TODO usuario local mesmo
com a senha certa. O salt correto e simplesmente `salt_hex.encode("utf-8")`.

Parametros scrypt: todos default do Node (N=16384, r=8, p=1, dklen=64) --
Node e Python tambem usam o mesmo default de maxmem (32 MiB) quando nao
especificado, entao nao precisa ser passado explicitamente aqui.
"""
import asyncio
import hashlib
import hmac
import secrets
from typing import Callable, Optional

_N = 16384
_R = 8
_P = 1
_DKLEN = 64


def hash_password(password: str) -> str:
    # secrets.token_hex(16) == crypto.randomBytes(16).toString('hex') do
    # Node: 16 bytes aleatorios, ja como string hex de 32 caracteres -- essa
    # STRING (nao os bytes que ela representa) e o salt usado abaixo, ver
    # docstring do modulo.
    salt_hex = secrets.token_hex(16)
    digest = hashlib.scrypt(
        str(password).encode("utf-8"),
        salt=salt_hex.encode("utf-8"),
        n=_N, r=_R, p=_P, dklen=_DKLEN,
    )
    return f"{salt_hex}:{digest.hex()}"


def verify_password(password, stored) -> bool:
    if not stored or not isinstance(stored, str) or ":" not in stored:
        return False
    salt_hex, hash_hex = stored.split(":", 1)
    try:
        expected = bytes.fromhex(hash_hex)
        actual = hashlib.scrypt(
            str(password).encode("utf-8"),
            salt=salt_hex.encode("utf-8"),  # ver docstring -- a STRING, nao bytes.fromhex(salt_hex)
            n=_N, r=_R, p=_P, dklen=len(expected),
        )
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


def generate_session_token() -> str:
    return secrets.token_hex(32)


# ---------------------------------------------------------------------------
# scrypt FORA do event loop
#
# hashlib.scrypt leva dezenas de ms de CPU (e 16 MiB de memoria) por chamada. Se
# rodar direto dentro de uma rota `async def`, trava o event loop inteiro
# enquanto calcula: uma rajada de tentativas de login deixava TODAS as
# requisicoes (inclusive /api/health e o healthcheck do Docker) esperando em
# fila. Aqui o calculo vai para uma thread (hashlib.scrypt solta o GIL) e um
# semaforo limita quantos rodam ao mesmo tempo (memoria e CPU previsiveis); o
# que passar de MAX_PENDING na fila e recusado na hora (HashingBusy -> 503)
# em vez de acumular.
# ---------------------------------------------------------------------------
SCRYPT_CONCURRENCY = 2
MAX_PENDING = 32


class HashingBusy(Exception):
    """Fila de calculo de hash cheia -- o servidor esta sob carga."""


_sem_loop: Optional[asyncio.AbstractEventLoop] = None
_sem: Optional[asyncio.Semaphore] = None
_pending = 0


def _semaphore() -> asyncio.Semaphore:
    # Um asyncio.Semaphore pertence a um event loop; recria se o loop mudou
    # (so acontece em testes que abrem mais de um loop).
    global _sem, _sem_loop
    loop = asyncio.get_running_loop()
    if _sem is None or _sem_loop is not loop:
        _sem, _sem_loop = asyncio.Semaphore(SCRYPT_CONCURRENCY), loop
    return _sem


async def _run_limited(fn: Callable, *args):
    global _pending
    if _pending >= MAX_PENDING:
        raise HashingBusy()
    _pending += 1
    try:
        async with _semaphore():
            return await asyncio.to_thread(fn, *args)
    finally:
        _pending -= 1


async def hash_password_async(password: str) -> str:
    return await _run_limited(hash_password, password)


async def verify_password_async(password, stored) -> bool:
    return await _run_limited(verify_password, password, stored)


# Hash descartavel: quando o usuario nao existe (ou esta desativado), o login
# ainda assim calcula um scrypt, para a resposta demorar o mesmo e nao revelar
# quais usuarios existem.
_dummy_hash: Optional[str] = None


async def burn_verify(password) -> None:
    global _dummy_hash
    if _dummy_hash is None:
        _dummy_hash = hash_password(secrets.token_hex(8))
    await _run_limited(verify_password, password, _dummy_hash)
