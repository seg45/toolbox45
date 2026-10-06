"""Sanitizacao de HTML rico (campo `details` de um comando, e notas de
pasta) -- allow-list de tags e atributos, aplicada por CONSTRUCAO.

Historico: a primeira versao (porta fiel do sanitizeNoteHtml() do backend
Node) era baseada em regex que localizava cada tag e a reescrevia. Esse
desenho tem um furo inerente: quando o regex NAO casa com uma tag
malformada (ex.: um `<` dentro da lista de atributos, como em
`<img src=x onerror=... <b>`), o trecho original passava INTACTO para a
saida e o navegador o interpretava como uma tag real com `onerror`
(XSS armazenado). Aqui o HTML e tokenizado por um parser de verdade
(html.parser) e a saida e MONTADA do zero: so as tags da allow-list, so os
atributos tratados explicitamente abaixo (os valores sao reescapados), e
TODO texto e escapado. Nada do que veio na entrada chega na saida sem passar
por essa reconstrucao, entao uma tag malformada vira texto inofensivo em vez
de markup.

Comportamento preservado da versao anterior (conteudo legitimo nao muda):
  * tags permitidas: b strong i em u br p div span ul ol li a img;
  * <font color=...> vira <span style="color:...">;
  * style so sobrevive com color (#rgb/#rrggbb/rgb()), font-size (NNpx) e
    text-align (left|center|right|justify);
  * <a>: href so http(s) (senao "#"), sempre target=_blank + rel noopener;
  * <img>: src so data:image/ ou http(s), width/height inteiros;
  * <script>/<style> somem junto com o conteudo; outras tags nao permitidas
    somem mas o texto de dentro e mantido.
Novidades: comentarios/doctype/CDATA sao descartados, tags sao fechadas na
ordem certa (o que sobrar aberto e fechado no fim; fechamento sem abertura e
ignorado).
"""
import html as _html
import re
from html.parser import HTMLParser

NOTE_ALLOWED_TAGS = {"b", "strong", "i", "em", "u", "br", "p", "div", "span", "ul", "ol", "li", "a", "img"}
_VOID_TAGS = {"br", "img"}
_DROP_WITH_CONTENT = {"script", "style"}

_HEX_COLOR_ATTR_RE = re.compile(r"^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$")
_DATA_IMAGE_RE = re.compile(r"^data:image/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]*$", re.IGNORECASE)
_HTTP_URL_RE = re.compile(r"^https?://", re.IGNORECASE)
_INT_RE = re.compile(r"^\s*(\d+)")

_COLOR_VALUE_RE = re.compile(r"^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$|^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$")
_FONT_SIZE_RE = re.compile(r"^\d{1,3}px$")
_STYLE_DECL_RE = re.compile(r"^\s*([a-zA-Z-]+)\s*:\s*(.+?)\s*$")
# Caracteres de controle/espacos que navegadores ignoram dentro de URLs e
# que poderiam esconder um esquema (ex.: "java\tscript:") -- qualquer URL que
# os contenha e recusada.
_BAD_URL_CHARS_RE = re.compile(r"[\x00-\x20\x7f]")


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


def _attr(attrs, name):
    for k, v in attrs:
        if k == name:
            return v if v is not None else ""
    return None


def _esc_attr(value: str) -> str:
    return _html.escape(value, quote=True)


def _safe_url(value, allow_data_image: bool) -> str:
    """Devolve a URL limpa (sem espacos nas pontas) se for permitida, senao ''."""
    url = (value or "").strip()
    if allow_data_image and _DATA_IMAGE_RE.match(url):
        # data:image/...;base64 -- remove quebras de linha que o base64 possa ter.
        return re.sub(r"\s+", "", url)
    if _BAD_URL_CHARS_RE.search(url):
        return ""
    return url if _HTTP_URL_RE.match(url) else ""


class _Sanitizer(HTMLParser):
    def __init__(self) -> None:
        # convert_charrefs=False: entidades em texto (&amp; &#39; ...) chegam
        # pelos handlers abaixo e sao repassadas como estao (nunca viram
        # "<" cru, so sao decodificadas pelo navegador como TEXTO).
        super().__init__(convert_charrefs=False)
        self.out: list = []
        self.stack: list = []  # nomes de saida (font -> span) das tags abertas
        self._skip: str = ""   # nome da tag script/style cujo conteudo esta sendo descartado

    # -- texto -------------------------------------------------------------
    def handle_data(self, data: str) -> None:
        if self._skip:
            return
        self.out.append(data.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))

    def handle_entityref(self, name: str) -> None:
        if self._skip:
            return
        if re.fullmatch(r"[A-Za-z][A-Za-z0-9]{0,31}", name):
            self.out.append(f"&{name};")
        else:
            self.out.append(_html.escape(f"&{name};"))

    def handle_charref(self, name: str) -> None:
        if self._skip:
            return
        if re.fullmatch(r"(?:[0-9]{1,7}|[xX][0-9a-fA-F]{1,6})", name):
            self.out.append(f"&#{name};")
        else:
            self.out.append(_html.escape(f"&#{name};"))

    # comentarios, doctype, <?...?>, <![CDATA[...]]>: descartados
    def handle_comment(self, data: str) -> None:
        pass

    def handle_decl(self, decl: str) -> None:
        pass

    def handle_pi(self, data: str) -> None:
        pass

    def unknown_decl(self, data: str) -> None:
        pass

    # -- tags --------------------------------------------------------------
    def handle_startendtag(self, tag, attrs) -> None:
        self.handle_starttag(tag, attrs)
        # <b/> nao fecha nada em HTML, mas <br/> e <img/> sao void de qualquer
        # forma -- nada a fazer aqui.

    def handle_starttag(self, tag, attrs) -> None:
        tag = tag.lower()
        if self._skip:
            return
        if tag in _DROP_WITH_CONTENT:
            self._skip = tag
            return

        if tag == "font":
            style_out = _sanitize_note_style(_attr(attrs, "style") or "")
            color_attr = _attr(attrs, "color")
            if not style_out and color_attr and _HEX_COLOR_ATTR_RE.match(color_attr):
                style_out = f"color:{color_attr}"
            self.out.append(f'<span style="{_esc_attr(style_out)}">' if style_out else "<span>")
            self.stack.append("span")
            return

        if tag not in NOTE_ALLOWED_TAGS:
            return

        if tag == "img":
            src = _safe_url(_attr(attrs, "src"), allow_data_image=True)
            if not src:
                return
            out = f'<img src="{_esc_attr(src)}"'
            w = _INT_RE.match(_attr(attrs, "width") or "")
            h = _INT_RE.match(_attr(attrs, "height") or "")
            if w:
                out += f' width="{int(w.group(1))}"'
            if h:
                out += f' height="{int(h.group(1))}"'
            self.out.append(out + ">")
            return

        if tag == "br":
            self.out.append("<br>")
            return

        if tag == "a":
            href = _safe_url(_attr(attrs, "href"), allow_data_image=False) or "#"
            self.out.append(f'<a href="{_esc_attr(href)}" target="_blank" rel="noopener noreferrer">')
            self.stack.append("a")
            return

        # span/div/p/li/ul/ol/b/strong/i/em/u: so `style` (restrito) sobrevive.
        style_out = _sanitize_note_style(_attr(attrs, "style") or "")
        self.out.append(f'<{tag} style="{_esc_attr(style_out)}">' if style_out else f"<{tag}>")
        self.stack.append(tag)

    def handle_endtag(self, tag) -> None:
        tag = tag.lower()
        if self._skip:
            if tag == self._skip:
                self._skip = ""
            return
        if tag == "br":
            self.out.append("<br>")  # "</br>" e lido pelos navegadores como <br>
            return
        name = "span" if tag == "font" else tag
        if name not in NOTE_ALLOWED_TAGS or name in _VOID_TAGS:
            return
        if name not in self.stack:
            return  # fechamento sem abertura correspondente
        # Fecha o que estiver aberto por dentro, na ordem, ate `name`.
        while self.stack:
            top = self.stack.pop()
            self.out.append(f"</{top}>")
            if top == name:
                break

    def result(self) -> str:
        while self.stack:
            self.out.append(f"</{self.stack.pop()}>")
        return "".join(self.out)


def sanitize_note_html(html) -> str:
    if not html:
        return ""
    text = str(html)
    parser = _Sanitizer()
    try:
        parser.feed(text)
        parser.close()
    except Exception:  # noqa: BLE001 -- nunca deixa uma entrada estranha derrubar a rota
        return _html.escape(text, quote=False)
    return parser.result()
