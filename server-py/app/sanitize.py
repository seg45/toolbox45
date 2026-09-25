"""Sanitizacao de HTML rico (campo `details` de um comando, e notas de
pasta) -- porta REGEX-por-REGEX de sanitizeNoteHtml()/_sanitizeNoteStyle()
em server/index.js. Allow-list de tags fixa (NOTE_ALLOWED_TAGS); qualquer
atributo que nao seja tratado explicitamente abaixo (inclusive on*="...")
e descartado.
"""
import re

NOTE_ALLOWED_TAGS = {"b", "strong", "i", "em", "u", "br", "p", "div", "span", "ul", "ol", "li", "a", "img"}

_SCRIPT_STYLE_RE = re.compile(r"<(script|style)[^>]*>[\s\S]*?</\1>", re.IGNORECASE)
_TAG_RE = re.compile(r"<(/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*)?)\s*/?>")

_COLOR_ATTR_DQ = re.compile(r'\bcolor\s*=\s*"([^"]*)"', re.IGNORECASE)
_COLOR_ATTR_SQ = re.compile(r"\bcolor\s*=\s*'([^']*)'", re.IGNORECASE)
_STYLE_ATTR_DQ = re.compile(r'\bstyle\s*=\s*"([^"]*)"', re.IGNORECASE)
_STYLE_ATTR_SQ = re.compile(r"\bstyle\s*=\s*'([^']*)'", re.IGNORECASE)
_SRC_ATTR_DQ = re.compile(r'\bsrc\s*=\s*"([^"]*)"', re.IGNORECASE)
_SRC_ATTR_SQ = re.compile(r"\bsrc\s*=\s*'([^']*)'", re.IGNORECASE)
_WIDTH_ATTR_RE = re.compile(r'\bwidth\s*=\s*"?(\d+)', re.IGNORECASE)
_HEIGHT_ATTR_RE = re.compile(r'\bheight\s*=\s*"?(\d+)', re.IGNORECASE)
_HREF_ATTR_DQ = re.compile(r'\bhref\s*=\s*"([^"]*)"', re.IGNORECASE)
_HREF_ATTR_SQ = re.compile(r"\bhref\s*=\s*'([^']*)'", re.IGNORECASE)

_HEX_COLOR_ATTR_RE = re.compile(r"^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$")
_DATA_IMAGE_RE = re.compile(r"^data:image/", re.IGNORECASE)
_HTTP_URL_RE = re.compile(r"^https?://", re.IGNORECASE)

_COLOR_VALUE_RE = re.compile(r"^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$|^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$")
_FONT_SIZE_RE = re.compile(r"^\d{1,3}px$")
_STYLE_DECL_RE = re.compile(r"^\s*([a-zA-Z-]+)\s*:\s*(.+?)\s*$")


def _first_match(patterns, attrs: str):
    for p in patterns:
        m = p.search(attrs)
        if m:
            return m.group(1)
    return None


def _sanitize_note_style(style_attr) -> str:
    if not style_attr:
        return ""
    kept = []
    for decl in str(style_attr).split(";"):
        m = _STYLE_DECL_RE.match(decl)
        if not m:
            continue
        prop = m.group(1).lower()
        val = m.group(2).strip()
        if prop == "color" and _COLOR_VALUE_RE.match(val):
            kept.append(f"color:{val}")
        elif prop == "font-size" and _FONT_SIZE_RE.match(val):
            kept.append(f"font-size:{val}")
        elif prop == "text-align" and val.lower() in ("left", "center", "right", "justify"):
            kept.append(f"text-align:{val.lower()}")
    return ";".join(kept)


def sanitize_note_html(html) -> str:
    if not html:
        return ""
    s = _SCRIPT_STYLE_RE.sub("", str(html))

    def replace_tag(m: "re.Match") -> str:
        closing = m.group(1)
        tag = m.group(2)
        attrs = m.group(3) or ""
        lower = tag.lower()

        if lower == "font":
            # <font ...>/</font> -- alguns navegadores ainda emitem isso pra
            # document.execCommand('foreColor', ...) em vez de um <span
            # style="color:...">; convertido pra <span> (cor preservada via
            # style, nunca via atributo legado `color`).
            if closing:
                return "</span>"
            color_attr = _first_match([_COLOR_ATTR_DQ, _COLOR_ATTR_SQ], attrs)
            style_val = _first_match([_STYLE_ATTR_DQ, _STYLE_ATTR_SQ], attrs)
            style_out = _sanitize_note_style(style_val or "")
            if not style_out and color_attr and _HEX_COLOR_ATTR_RE.match(color_attr):
                style_out = f"color:{color_attr}"
            return f'<span style="{style_out}">' if style_out else "<span>"

        if lower not in NOTE_ALLOWED_TAGS:
            return ""
        if closing:
            return f"</{lower}>"

        if lower == "img":
            src = _first_match([_SRC_ATTR_DQ, _SRC_ATTR_SQ], attrs) or ""
            width_m = _WIDTH_ATTR_RE.search(attrs)
            height_m = _HEIGHT_ATTR_RE.search(attrs)
            if not _DATA_IMAGE_RE.match(src) and not _HTTP_URL_RE.match(src):
                return ""
            out = f'<img src="{src.replace(chr(34), "&quot;")}"'
            if width_m:
                out += f' width="{int(width_m.group(1))}"'
            if height_m:
                out += f' height="{int(height_m.group(1))}"'
            return out + ">"

        if lower == "a":
            href = _first_match([_HREF_ATTR_DQ, _HREF_ATTR_SQ], attrs) or ""
            if not _HTTP_URL_RE.match(href):
                href = "#"
            return f'<a href="{href.replace(chr(34), "&quot;")}" target="_blank" rel="noopener noreferrer">'

        # span/div/p/li/ul/ol/b/strong/i/em/u/br: so `style` sobrevive
        # (validado e restrito as 3 propriedades acima) -- qualquer outro
        # atributo original continua descartado.
        style_val = _first_match([_STYLE_ATTR_DQ, _STYLE_ATTR_SQ], attrs)
        style_out = _sanitize_note_style(style_val or "")
        return f'<{lower} style="{style_out}">' if style_out else f"<{lower}>"

    return _TAG_RE.sub(replace_tag, s)
