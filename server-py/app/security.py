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
import hashlib
import hmac
import secrets

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
