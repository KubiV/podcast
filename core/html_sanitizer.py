"""
Allowlist sanitizace HTML (bez externích závislostí) pro obsah, který server vrací jako HTML stránku
(tiskový náhled). Bezpečnost plyne z konstrukce výstupu, ne z hledání zakázaných vzorů:
- vypisují se jen povolené tagy a povolené atributy (žádné on*), vše ostatní se zahodí,
- veškerý text i hodnoty atributů se znovu escapují,
- obsah nebezpečných elementů (script, style, iframe…) se zahodí celý,
- URL v href/src musí být relativní nebo http(s)/mailto/tel, obrázky smí i data:image/*,
- výstup má vyvážené tagy, takže nemůže "uniknout" z obalujícího elementu šablony.

Allowlist pokrývá výstup marked (markdown), citační odznaky a KaTeX (HTML, MathML i SVG).
"""

import re
from html import escape
from html.parser import HTMLParser

ALLOWED_TAGS = {
    # text a struktura
    "p",
    "br",
    "hr",
    "div",
    "span",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "strong",
    "b",
    "em",
    "i",
    "u",
    "s",
    "del",
    "ins",
    "mark",
    "small",
    "sup",
    "sub",
    "abbr",
    "kbd",
    "ul",
    "ol",
    "li",
    "dl",
    "dt",
    "dd",
    "blockquote",
    "pre",
    "code",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "th",
    "td",
    "caption",
    "colgroup",
    "col",
    "a",
    "img",
    "figure",
    "figcaption",
    "details",
    "summary",
    "input",
    # KaTeX MathML
    "math",
    "semantics",
    "annotation",
    "mrow",
    "mi",
    "mo",
    "mn",
    "ms",
    "mtext",
    "mspace",
    "msup",
    "msub",
    "msubsup",
    "mfrac",
    "msqrt",
    "mroot",
    "mover",
    "munder",
    "munderover",
    "mtable",
    "mtr",
    "mtd",
    "mstyle",
    "mpadded",
    "mphantom",
    "menclose",
    # KaTeX SVG (odmocniny, šipky)
    "svg",
    "path",
    "line",
    "g",
}

VOID_TAGS = {"br", "hr", "img", "input", "col", "path", "line"}

# Elementy, jejichž obsah se zahodí celý (nejen tag)
DROP_WITH_CONTENT = {
    "script",
    "style",
    "iframe",
    "frame",
    "frameset",
    "object",
    "embed",
    "applet",
    "template",
    "noscript",
    "noembed",
    "noframes",
    "textarea",
    "select",
    "option",
    "title",
    "xmp",
    "plaintext",
    "head",
    "canvas",
    "audio",
    "video",
    "source",
    "track",
    "form",
    "button",
    "link",
    "meta",
    "base",
    "param",
    "foreignobject",
}

# Bez "id"/"name": zabraňuje DOM clobberingu globálních proměnných stránky
GLOBAL_ATTRS = {"class", "title", "lang", "dir", "style", "aria-hidden", "role"}
TAG_ATTRS = {
    "a": {"href"},
    "img": {"src", "alt", "width", "height"},
    "input": {"type", "checked", "disabled"},
    "ol": {"start", "type"},
    "li": {"value"},
    "th": {"align", "colspan", "rowspan", "scope"},
    "td": {"align", "colspan", "rowspan"},
    "col": {"span", "width"},
    "colgroup": {"span"},
    "details": {"open"},
    "code": set(),
    "math": {"xmlns", "display"},
    "annotation": {"encoding"},
    "mi": {"mathvariant"},
    "mo": {"stretchy", "fence", "separator", "lspace", "rspace", "minsize", "maxsize", "movablelimits"},
    "mspace": {"width"},
    "mpadded": {"width", "height", "depth", "voffset", "lspace"},
    "mstyle": {"displaystyle", "scriptlevel", "mathcolor", "mathsize"},
    "mover": {"accent"},
    "munder": {"accentunder"},
    "munderover": {"accent", "accentunder"},
    "mtable": {"rowspacing", "columnspacing", "columnalign", "rowlines", "columnlines"},
    "mtd": {"columnalign"},
    "mfrac": {"linethickness"},
    "menclose": {"notation"},
    "svg": {"xmlns", "width", "height", "viewbox", "preserveaspectratio"},
    "path": {"d"},
    "line": {"x1", "x2", "y1", "y2", "stroke-width"},
}
INPUT_TYPES = {"checkbox"}

# SVG atributy jsou case-sensitive, HTMLParser je převádí na malá písmena
SVG_ATTR_CASE = {"viewbox": "viewBox", "preserveaspectratio": "preserveAspectRatio"}

_SAFE_URL_SCHEMES = ("http", "https", "mailto", "tel")
_URL_SCHEME_RE = re.compile(r"^([a-zA-Z][a-zA-Z0-9+.-]*):")
_CONTROL_AND_SPACE_RE = re.compile(r"[\x00-\x20\x7f-\x9f]+")
_DATA_IMAGE_RE = re.compile(r"^data:image/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$", re.IGNORECASE)
_UNSAFE_CSS_RE = re.compile(r"url\s*\(|expression\s*\(|javascript:|@import|behavior\s*:|-moz-binding", re.IGNORECASE)


def _safe_url(value: str, allow_data_image: bool = False) -> bool:
    compact = _CONTROL_AND_SPACE_RE.sub("", value)
    match = _URL_SCHEME_RE.match(compact)
    if not match:
        return True  # relativní URL nebo kotva
    scheme = match.group(1).lower()
    if scheme in _SAFE_URL_SCHEMES:
        return True
    return allow_data_image and scheme == "data" and bool(_DATA_IMAGE_RE.match(value.strip()))


def _clean_attrs(tag: str, attrs: list[tuple[str, str | None]]) -> list[tuple[str, str | None]]:
    allowed = GLOBAL_ATTRS | TAG_ATTRS.get(tag, set())
    result = []
    for name, value in attrs:
        name = name.lower()
        if name not in allowed:
            continue
        if name in ("href", "src") and (value is None or not _safe_url(value, allow_data_image=(name == "src"))):
            continue
        if name == "style" and value and _UNSAFE_CSS_RE.search(value):
            continue
        if tag == "input" and name == "type" and (value or "").lower() not in INPUT_TYPES:
            return []  # jiný input než checkbox se nevypisuje
        result.append((SVG_ATTR_CASE.get(name, name), value))
    if tag == "input" and not any(n == "type" for n, _ in result):
        return []
    return result


class _Sanitizer(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.stack: list[str] = []
        # Zahazovaný blok: tag, kterým začal, a hloubka jeho vnoření (jiné tagy uvnitř se nepočítají)
        self.drop_tag: str | None = None
        self.drop_depth = 0

    def _emit_start(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        cleaned = _clean_attrs(tag, attrs)
        if tag == "input" and not cleaned:
            return
        parts = [tag]
        for name, value in cleaned:
            parts.append(name if value is None else f'{name}="{escape(value, quote=True)}"')
        self.out.append(f"<{' '.join(parts)}>")
        if tag not in VOID_TAGS:
            self.stack.append(tag)
        elif tag in ("path", "line"):
            self.out[-1] = self.out[-1][:-1] + "></" + tag + ">"

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if self.drop_depth:
            if tag == self.drop_tag:
                self.drop_depth += 1
            return
        if tag in DROP_WITH_CONTENT:
            if tag not in ("link", "meta", "base", "param", "source", "track"):
                self.drop_tag = tag
                self.drop_depth = 1
            return
        if tag in ALLOWED_TAGS:
            self._emit_start(tag, attrs)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if self.drop_depth or tag in DROP_WITH_CONTENT or tag not in ALLOWED_TAGS:
            return
        self._emit_start(tag, attrs)
        if tag not in VOID_TAGS and self.stack and self.stack[-1] == tag:
            self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if self.drop_depth:
            if tag == self.drop_tag:
                self.drop_depth -= 1
                if not self.drop_depth:
                    self.drop_tag = None
            return
        if tag not in self.stack:
            return  # neotevřený nebo nepovolený tag se nezavírá
        while self.stack:
            open_tag = self.stack.pop()
            self.out.append(f"</{open_tag}>")
            if open_tag == tag:
                break

    def handle_data(self, data: str) -> None:
        if not self.drop_depth:
            self.out.append(escape(data, quote=False))

    # komentáře, deklarace a processing instructions se zahazují (výchozí chování HTMLParser je ignoruje)

    def result(self) -> str:
        self.close()
        while self.stack:
            self.out.append(f"</{self.stack.pop()}>")
        return "".join(self.out)


def sanitize_html(markup: str) -> str:
    """Vrátí bezpečnou podmnožinu HTML (viz docstring modulu)."""
    if not markup:
        return ""
    sanitizer = _Sanitizer()
    sanitizer.feed(markup)
    return sanitizer.result()
