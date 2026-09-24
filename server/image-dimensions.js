// Lê width/height de um Buffer PNG/JPEG/WEBP a partir dos bytes do arquivo,
// sem nenhuma biblioteca de imagem como dependência (sharp/jimp não fazem
// parte do projeto, ver server/package.json) — usado só pra validar o
// limite de dimensão no upload de logo (Settings -> System -> Logo, ver
// PUT /api/system/logo em server/index.js). Pedido do usuário: "inclua
// dimensões e tamanho máximo da imagem" (complementa LOGO_MAX_BYTES, que já
// limitava só o tamanho do arquivo em bytes, não a resolução).
// Lê width/height de um Buffer PNG/JPEG/WEBP sem nenhuma dependência de
// terceiros (sharp/jimp não fazem parte do projeto) — parse mínimo dos
// headers de cada formato, o suficiente pra validar limite de dimensão no
// upload de logo (ver LOGO_ALLOWED_MIME em server/index.js).
function getImageDimensions(buf, mimeType) {
  try {
    if (mimeType === 'image/png') return getPngDimensions(buf);
    if (mimeType === 'image/jpeg') return getJpegDimensions(buf);
    if (mimeType === 'image/webp') return getWebpDimensions(buf);
  } catch (e) {
    return null;
  }
  return null;
}

function getPngDimensions(buf) {
  // Assinatura PNG (8 bytes) + chunk IHDR: length(4) type(4)='IHDR' width(4) height(4) ...
  if (buf.length < 24) return null;
  const sig = buf.toString('hex', 0, 8);
  if (sig !== '89504e470d0a1a0a') return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function getJpegDimensions(buf) {
  // JPEG = sequência de marcadores 0xFF 0xXX; procura o marcador SOFn
  // (Start Of Frame, contém as dimensões) pulando os demais segmentos pelo
  // tamanho declarado em cada um.
  if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
  let offset = 2;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xFF) { offset++; continue; }
    const marker = buf[offset + 1];
    // Marcadores sem payload (não têm campo de tamanho depois)
    if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const segLen = buf.readUInt16BE(offset + 2);
    const isSOF = (marker >= 0xC0 && marker <= 0xCF) && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
    if (isSOF) {
      if (offset + 9 > buf.length) return null;
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      return { width, height };
    }
    offset += 2 + segLen;
  }
  return null;
}

function getWebpDimensions(buf) {
  // Container RIFF: 'RIFF' size(4) 'WEBP' <chunk fourcc(4) size(4) payload>
  if (buf.length < 30) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const fourcc = buf.toString('ascii', 12, 16);
  if (fourcc === 'VP8X') {
    // Extended format: 1 byte flags + 3 bytes reserved, depois
    // width-1 (24 bits LE) e height-1 (24 bits LE).
    const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { width: w, height: h };
  }
  if (fourcc === 'VP8 ') {
    // Lossy: procura o start code 0x9D 0x01 0x2A do bitstream VP8, seguido
    // de width/height em 14 bits cada (top 2 bits = scale, ignorados).
    for (let i = 20; i + 10 <= buf.length; i++) {
      if (buf[i] === 0x9D && buf[i + 1] === 0x01 && buf[i + 2] === 0x2A) {
        const w = buf.readUInt16LE(i + 3) & 0x3FFF;
        const h = buf.readUInt16LE(i + 5) & 0x3FFF;
        return { width: w, height: h };
      }
    }
    return null;
  }
  if (fourcc === 'VP8L') {
    // Lossless: byte 0 = 0x2F (signature), depois 14 bits width-1 + 14
    // bits height-1 empacotados em little-endian a partir do byte 21.
    if (buf[20] !== 0x2F) return null;
    const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
    const w = 1 + (((b1 & 0x3F) << 8) | b0);
    const h = 1 + (((b3 & 0x0F) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6));
    return { width: w, height: h };
  }
  return null;
}

module.exports = { getImageDimensions };

