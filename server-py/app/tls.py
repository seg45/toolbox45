"""Certificado TLS customizavel (Settings -> System -> SSL Certificate,
admin-only) + bootstrap de um autoassinado no boot -- porta 1:1 de
server/index.js (funcoes ensureTlsBootstrap/generateSelfSignedCert/
backupCurrentTlsFiles/readCertInfo/certKeyMatch e as rotas GET/POST/DELETE
/api/system/ssl-certificate, ver app/routers/system.py).

Diferenca deliberada em relacao ao Node: o Node usa o modulo builtin
`crypto` (X509Certificate/createPrivateKey) tanto pra PARSEAR certificados
quanto pra COMPARAR chaves publicas -- aqui usamos a biblioteca
`cryptography` (adicionada em server-py/requirements.txt so nesta fatia)
pro equivalente funcional; a GERACAO do autoassinado continua via
subprocess `openssl` (mesmo comando/argumentos do Node, so trocando
`execFile` por `asyncio.create_subprocess_exec`). Os campos de
subject/issuer/validFrom/validTo/fingerprint256/serialNumber devolvidos por
GET/POST/DELETE sao formatados pra bater o mais perto possivel da
convencao do OpenSSL/Node (ver comentarios em read_cert_info) -- sao campos
so de EXIBICAO na UI admin, nunca reprocessados por codigo, entao uma
diferenca cosmetica de formatacao num caso de borda (certificado real com
subject multi-RDN complexo) nao quebra nenhum fluxo, so a apresentacao.
"""
import asyncio
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, TypedDict

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

# Mesmo default relativo do Node (path.join(__dirname, 'tls')) -- dentro da
# imagem Docker (server-py/Dockerfile, WORKDIR /app) isto resolve pra
# /app/tls, igual ao __dirname do backend Node no container dele (tambem
# /app) -- mesmo caminho, mas volumes SEPARADOS (ver docker-compose.yml:
# este backend ainda nao esta na wave de deploy, so a Fase 4 cuida disso).
# TLS_DIR (variavel de ambiente) sobrepõe o default nos dois backends.
TLS_DIR = Path(os.environ.get("TLS_DIR") or (Path(__file__).resolve().parent.parent / "tls"))
TLS_CERT_PATH = TLS_DIR / "cert.pem"
TLS_KEY_PATH = TLS_DIR / "key.pem"
TLS_BACKUP_DIR = TLS_DIR / "backup"


class CertInfo(TypedDict):
    subject: str
    issuer: str
    validFrom: str
    validTo: str
    fingerprint256: str
    serialNumber: str
    isSelfSigned: bool
    isExpired: bool


async def _run_cli(cmd: str, args: list) -> None:
    proc = await asyncio.create_subprocess_exec(
        cmd, *args,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"{cmd} exited with code {proc.returncode}: {stderr.decode('utf-8', errors='replace')}")


async def generate_self_signed_cert() -> None:
    TLS_DIR.mkdir(parents=True, exist_ok=True)
    await _run_cli("openssl", [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", str(TLS_KEY_PATH), "-out", str(TLS_CERT_PATH),
        "-days", "825", "-subj", "/CN=toolbox45",
    ])


async def ensure_tls_bootstrap() -> None:
    """Roda no boot, ANTES do healthcheck responder (ver lifespan em
    app/main.py) -- decide se ja existe certificado checando so a
    EXISTENCIA dos dois arquivos no disco (nao consulta banco nem valida
    conteudo/validade do cert existente), exatamente como o Node."""
    TLS_DIR.mkdir(parents=True, exist_ok=True)
    if not TLS_CERT_PATH.exists() or not TLS_KEY_PATH.exists():
        await generate_self_signed_cert()


def _backup_timestamp() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def backup_current_tls_files() -> None:
    if not TLS_CERT_PATH.exists() and not TLS_KEY_PATH.exists():
        return
    dest = TLS_BACKUP_DIR / _backup_timestamp()
    dest.mkdir(parents=True, exist_ok=True)
    if TLS_CERT_PATH.exists():
        shutil.copyfile(TLS_CERT_PATH, dest / "cert.pem")
    if TLS_KEY_PATH.exists():
        shutil.copyfile(TLS_KEY_PATH, dest / "key.pem")


def format_name(name: x509.Name) -> str:
    # rfc4514_string() ordena do mais especifico pro menos especifico,
    # separado por virgula (ex.: "CN=toolbox45") -- bate exatamente com o
    # que o Node devolve pro autoassinado default (-subj '/CN=toolbox45',
    # uma unica RDN com um unico atributo). Um certificado real com varias
    # RDNs pode formatar ligeiramente diferente do node -- ver docstring do
    # modulo, e um campo so de exibicao. Publica (sem "_") -- reaproveitada
    # por app/routers/system.py no audit log do POST de import.
    return name.rfc4514_string()


def format_validity_date(dt: datetime) -> str:
    # Aproxima o formato do OpenSSL/Node ("Sep 26 00:00:00 2026 GMT" --
    # dia com espaço em vez de zero à esquerda quando é um único dígito).
    # Publica -- reaproveitada por app/routers/system.py na mensagem de
    # erro "expired" e no audit log do POST de import.
    return f"{dt.strftime('%b')} {dt.day:2d} {dt.strftime('%H:%M:%S %Y')} GMT"


def read_cert_info() -> CertInfo:
    pem = TLS_CERT_PATH.read_bytes()
    cert = x509.load_pem_x509_certificate(pem)
    fingerprint = cert.fingerprint(hashes.SHA256())
    fingerprint256 = ":".join(f"{b:02X}" for b in fingerprint)
    serial_hex = format(cert.serial_number, "X")
    if len(serial_hex) % 2:
        serial_hex = "0" + serial_hex
    subject = format_name(cert.subject)
    issuer = format_name(cert.issuer)
    not_after = cert.not_valid_after_utc
    return {
        "subject": subject,
        "issuer": issuer,
        "validFrom": format_validity_date(cert.not_valid_before_utc),
        "validTo": format_validity_date(not_after),
        "fingerprint256": fingerprint256,
        "serialNumber": serial_hex,
        "isSelfSigned": subject == issuer,
        "isExpired": not_after < datetime.now(timezone.utc),
    }


def parse_cert(cert_pem: str) -> x509.Certificate:
    """Levanta ValueError se o PEM nao parsear como X.509 -- chamador
    converte isso pro 400 {"error":"invalid_cert",...} (ver
    app/routers/system.py)."""
    return x509.load_pem_x509_certificate(cert_pem.encode("utf-8"))


def parse_private_key(key_pem: str):
    """Levanta ValueError/TypeError se o PEM nao parsear como chave privada
    SEM SENHA -- chamador converte isso pro 400 {"error":"invalid_key",...}.
    password=None faz a biblioteca recusar (com excecao) uma chave
    criptografada, igual ao requisito 'UNENCRYPTED' do Node."""
    return serialization.load_pem_private_key(key_pem.encode("utf-8"), password=None)


def cert_key_match(cert_pem: str, key_pem: str) -> bool:
    """Compara as chaves PUBLICAS (formato SPKI/DER) do certificado e da
    chave privada enviados -- mesma tecnica do certKeyMatch() do Node,
    funciona igual pra RSA/EC sem logica especifica por algoritmo."""
    cert_pub = parse_cert(cert_pem).public_key()
    key_pub = parse_private_key(key_pem).public_key()
    cert_der = cert_pub.public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)
    key_der = key_pub.public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)
    return cert_der == key_der


def cert_not_valid_after(cert_pem: str) -> datetime:
    return parse_cert(cert_pem).not_valid_after_utc
