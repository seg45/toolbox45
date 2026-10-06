"""Cifra de segredos em repouso (hoje: `oauth_settings.client_secret`).

Auditoria de seguranca (out/2026): o client secret do Google/Microsoft ficava em
texto puro no banco -- e, portanto, em todo backup (`pg_dump`) e em qualquer
copia do volume do Postgres. Agora ele e gravado cifrado com AES-256-GCM e a
CHAVE NAO FICA NO BANCO: vem da variavel de ambiente TOOLBOX45_SECRET_KEY (arquivo
`.env` do servidor, fora do banco e dos backups). Quem tem so um dump nao
consegue ler o secret.

Formato gravado: ``enc:v1:<base64url(nonce[12] + ciphertext + tag[16])>``.
  * a chave de 256 bits e derivada da variavel por HKDF-SHA256;
  * o "contexto" (ex.: ``oauth:google``) entra como dado autenticado (AAD): um
    ciphertext copiado de uma linha para outra nao decifra.

Compatibilidade / casos de borda:
  * valor SEM o prefixo ``enc:v1:`` = legado em texto puro: continua sendo lido
    normalmente e e cifrado no proximo boot (``encrypt_legacy``) se houver chave;
  * sem chave configurada o app continua funcionando como antes (grava texto
    puro) e avisa no log -- nao quebra instalacao existente no deploy;
  * valor cifrado + chave ausente/errada -> ``SecretUnavailable``: o provedor
    OAuth fica sem credencial (o login local nao e afetado) ate configurar a
    chave certa ou salvar o secret de novo em Settings -> System -> OAuth.
Perder a chave = reconfigurar o OAuth (o secret nao e recuperavel). Guarde a
chave junto das demais senhas do servidor.
"""
import base64
import hashlib
import hmac
import logging
import os
from typing import Optional

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

logger = logging.getLogger("toolbox45")

PREFIX = "enc:v1:"
KEY_ENV = "TOOLBOX45_SECRET_KEY"
MIN_KEY_CHARS = 32
_HKDF_INFO = b"toolbox45/secrets-at-rest/v1"
_NONCE_BYTES = 12


class SecretUnavailable(Exception):
    """Valor cifrado que nao da para ler (chave ausente, errada ou dado corrompido)."""


def _raw_key() -> str:
    return os.environ.get(KEY_ENV, "").strip()


def key_configured() -> bool:
    return len(_raw_key()) >= MIN_KEY_CHARS


def key_problem() -> Optional[str]:
    """Texto curto se a variavel existe mas e inutilizavel (para o log de boot)."""
    raw = _raw_key()
    if raw and len(raw) < MIN_KEY_CHARS:
        return f"{KEY_ENV} tem menos de {MIN_KEY_CHARS} caracteres e foi ignorada"
    return None


def _aead() -> AESGCM:
    okm = HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=_HKDF_INFO).derive(_raw_key().encode("utf-8"))
    return AESGCM(okm)


def is_encrypted(value: Optional[str]) -> bool:
    return bool(value) and value.startswith(PREFIX)


def encrypt(plain: str, context: str) -> str:
    """Cifra `plain`. Sem chave configurada devolve o proprio texto (legado)."""
    if not key_configured():
        return plain
    nonce = os.urandom(_NONCE_BYTES)
    ct = _aead().encrypt(nonce, plain.encode("utf-8"), context.encode("utf-8"))
    return PREFIX + base64.urlsafe_b64encode(nonce + ct).decode("ascii")


def decrypt(stored: Optional[str], context: str) -> Optional[str]:
    """Texto puro de volta. Legado (sem prefixo) passa direto; cifrado sem chave
    valida levanta SecretUnavailable."""
    if not stored:
        return None
    if not stored.startswith(PREFIX):
        return stored
    if not key_configured():
        raise SecretUnavailable(f"valor cifrado mas {KEY_ENV} nao esta configurada")
    try:
        blob = base64.urlsafe_b64decode(stored[len(PREFIX):].encode("ascii"))
        nonce, ct = blob[:_NONCE_BYTES], blob[_NONCE_BYTES:]
        return _aead().decrypt(nonce, ct, context.encode("utf-8")).decode("utf-8")
    except (InvalidTag, ValueError, UnicodeError) as err:
        raise SecretUnavailable("nao foi possivel decifrar (chave diferente ou dado corrompido)") from err


def fingerprint() -> Optional[str]:
    """Identificador curto e NAO reversivel da chave atual (para o health check/logs:
    permite ver se a chave mudou sem expor a chave)."""
    if not key_configured():
        return None
    return hmac.new(_raw_key().encode("utf-8"), b"toolbox45-fp", hashlib.sha256).hexdigest()[:8]
