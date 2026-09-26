"""Le width/height de um buffer PNG/JPEG/WEBP a partir dos bytes do arquivo,
sem nenhuma biblioteca de imagem como dependencia -- porta 1:1 de
server/image-dimensions.js (parse minimo dos headers de cada formato, usado
so pra validar o limite de dimensao no upload de logo, ver PUT
/api/system/logo em app/routers/system.py).
"""
from typing import Optional, TypedDict


class ImageDims(TypedDict):
    width: int
    height: int


def get_image_dimensions(buf: bytes, mime_type: str) -> Optional[ImageDims]:
    try:
        if mime_type == "image/png":
            return _png_dimensions(buf)
        if mime_type == "image/jpeg":
            return _jpeg_dimensions(buf)
        if mime_type == "image/webp":
            return _webp_dimensions(buf)
    except Exception:  # noqa: BLE001 -- mesmo catch-all do JS original
        return None
    return None


def _png_dimensions(buf: bytes) -> Optional[ImageDims]:
    # Assinatura PNG (8 bytes) + chunk IHDR: length(4) type(4)='IHDR' width(4) height(4) ...
    if len(buf) < 24:
        return None
    if buf[0:8].hex() != "89504e470d0a1a0a":
        return None
    if buf[12:16] != b"IHDR":
        return None
    width = int.from_bytes(buf[16:20], "big")
    height = int.from_bytes(buf[20:24], "big")
    return {"width": width, "height": height}


def _jpeg_dimensions(buf: bytes) -> Optional[ImageDims]:
    # JPEG = sequencia de marcadores 0xFF 0xXX; procura o marcador SOFn
    # (Start Of Frame, contem as dimensoes) pulando os demais segmentos pelo
    # tamanho declarado em cada um.
    if len(buf) < 4 or buf[0] != 0xFF or buf[1] != 0xD8:
        return None
    offset = 2
    while offset + 4 <= len(buf):
        if buf[offset] != 0xFF:
            offset += 1
            continue
        marker = buf[offset + 1]
        # Marcadores sem payload (nao tem campo de tamanho depois)
        if marker == 0xD8 or marker == 0xD9 or (0xD0 <= marker <= 0xD7) or marker == 0x01:
            offset += 2
            continue
        seg_len = int.from_bytes(buf[offset + 2:offset + 4], "big")
        is_sof = (0xC0 <= marker <= 0xCF) and marker not in (0xC4, 0xC8, 0xCC)
        if is_sof:
            if offset + 9 > len(buf):
                return None
            height = int.from_bytes(buf[offset + 5:offset + 7], "big")
            width = int.from_bytes(buf[offset + 7:offset + 9], "big")
            return {"width": width, "height": height}
        offset += 2 + seg_len
    return None


def _webp_dimensions(buf: bytes) -> Optional[ImageDims]:
    # Container RIFF: 'RIFF' size(4) 'WEBP' <chunk fourcc(4) size(4) payload>
    if len(buf) < 30:
        return None
    if buf[0:4] != b"RIFF" or buf[8:12] != b"WEBP":
        return None
    fourcc = buf[12:16].decode("ascii", errors="replace")
    if fourcc == "VP8X":
        # Extended format: 1 byte flags + 3 bytes reservado, depois
        # width-1 (24 bits LE) e height-1 (24 bits LE).
        w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16))
        h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16))
        return {"width": w, "height": h}
    if fourcc == "VP8 ":
        # Lossy: procura o start code 0x9D 0x01 0x2A do bitstream VP8,
        # seguido de width/height em 14 bits cada (top 2 bits = scale, ignorados).
        i = 20
        while i + 10 <= len(buf):
            if buf[i] == 0x9D and buf[i + 1] == 0x01 and buf[i + 2] == 0x2A:
                w = int.from_bytes(buf[i + 3:i + 5], "little") & 0x3FFF
                h = int.from_bytes(buf[i + 5:i + 7], "little") & 0x3FFF
                return {"width": w, "height": h}
            i += 1
        return None
    if fourcc == "VP8L":
        # Lossless: byte 0 = 0x2F (assinatura), depois 14 bits width-1 + 14
        # bits height-1 empacotados em little-endian a partir do byte 21.
        if buf[20] != 0x2F:
            return None
        b0, b1, b2, b3 = buf[21], buf[22], buf[23], buf[24]
        w = 1 + (((b1 & 0x3F) << 8) | b0)
        h = 1 + (((b3 & 0x0F) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6))
        return {"width": w, "height": h}
    return None
