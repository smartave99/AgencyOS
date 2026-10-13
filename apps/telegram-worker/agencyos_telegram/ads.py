"""An ad to send: Telegram-HTML validation, media confinement and the exact text split.

Mirrors the Bot API provider (TelegramGateway): a caption holds at most 1024 visible characters,
a message at most 4096; when the text does not fit a caption the media goes first and the text
follows as a reply to the first media message.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from html.parser import HTMLParser
from urllib.parse import urlsplit

from .errors import BadRequest

CAPTION_LIMIT = 1024
MESSAGE_LIMIT = 4096
MAX_MEDIA = 10
MAX_HTML_CHARS = 32768
MAX_MEDIA_BYTES = 2 * 1024 * 1024 * 1024  # Telegram's upload limit for a regular account
BUTTON_TEXT_MAX = 64
BUTTON_URL_MAX = 512

ALLOWED_TAGS = frozenset({"b", "i", "u", "s", "code", "pre", "a"})
IMAGE_EXTENSIONS = frozenset({".jpg", ".jpeg", ".png", ".webp"})
VIDEO_EXTENSIONS = frozenset({".mp4", ".mov", ".webm", ".m4v"})
MEDIA_KINDS = ("photo", "video")

_CODE_CLASS = re.compile(r"^language-[A-Za-z0-9_+#.\-]{1,32}$")


def utf16_length(text: str) -> int:
    """Telegram measures message text in UTF-16 code units."""
    return len(text.encode("utf-16-le")) // 2


def is_http_url(value: str, max_length: int = BUTTON_URL_MAX) -> bool:
    if not value or len(value) > max_length or re.search(r"[\s\x00-\x1f\x7f]", value):
        return False
    try:
        parts = urlsplit(value)
        return parts.scheme in ("http", "https") and bool(parts.hostname)
    except ValueError:
        return False


class _TelegramHtml(HTMLParser):
    """Collects the visible text and rejects anything outside the allowed subset."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.text: list[str] = []
        self.stack: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag not in ALLOWED_TAGS:
            raise BadRequest(f"ad.html: <{tag}> is not allowed (allowed: b i u s code pre a)")
        attributes = dict(attrs)
        if tag == "a":
            if set(attributes) != {"href"} or not is_http_url(attributes["href"] or "", 2048):
                raise BadRequest("ad.html: <a> needs exactly one http(s) href")
        elif tag == "code" and "class" in attributes:
            if set(attributes) != {"class"} or not _CODE_CLASS.match(attributes["class"] or ""):
                raise BadRequest("ad.html: <code> may only carry class=\"language-...\"")
        elif attributes:
            raise BadRequest(f"ad.html: <{tag}> takes no attributes")
        self.stack.append(tag)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        raise BadRequest(f"ad.html: self-closing <{tag}/> is not allowed")

    def handle_endtag(self, tag: str) -> None:
        if not self.stack or self.stack.pop() != tag:
            raise BadRequest(f"ad.html: unbalanced </{tag}>")

    def handle_data(self, data: str) -> None:
        self.text.append(data)

    def handle_comment(self, data: str) -> None:
        raise BadRequest("ad.html: comments are not allowed")

    def handle_decl(self, decl: str) -> None:
        raise BadRequest("ad.html: declarations are not allowed")

    def handle_pi(self, data: str) -> None:
        raise BadRequest("ad.html: processing instructions are not allowed")

    def unknown_decl(self, data: str) -> None:
        raise BadRequest("ad.html: declarations are not allowed")


def visible_text(html: str) -> str:
    """Validate Telegram HTML and return the text a reader sees (stripped, like Telegram)."""
    if not isinstance(html, str) or not html.strip():
        raise BadRequest("ad.html must be a non-empty string")
    if len(html) > MAX_HTML_CHARS:
        raise BadRequest(f"ad.html is longer than {MAX_HTML_CHARS} characters")
    parser = _TelegramHtml()
    parser.feed(html)
    parser.close()
    if parser.stack:
        raise BadRequest(f"ad.html: <{parser.stack[-1]}> is never closed")
    text = "".join(parser.text).strip()
    if not text:
        raise BadRequest("ad.html has no visible text")
    return text


def resolve_media_path(raw: str, kind: str, media_root: str | None) -> tuple[str, int]:
    """Return (real path, size) of a media file that lies inside the media root, else BadRequest."""
    if not media_root:
        raise BadRequest("media is disabled: AGENCYOS_MEDIA_ROOT is not set")
    if not isinstance(raw, str) or not raw or "\x00" in raw or len(raw) > 1024:
        raise BadRequest("ad.media[].path must be a non-empty path")
    root = os.path.realpath(media_root)
    candidate = raw if os.path.isabs(raw) else os.path.join(root, raw)
    real = os.path.realpath(candidate)
    try:
        inside = os.path.normcase(os.path.commonpath([root, real])) == os.path.normcase(root)
    except ValueError:  # different drives on Windows
        inside = False
    if not inside or os.path.normcase(real) == os.path.normcase(root):
        raise BadRequest("ad.media[].path is outside the media root")
    if not os.path.isfile(real):
        raise BadRequest("ad.media[].path is not a file")
    extension = os.path.splitext(real)[1].lower()
    allowed = IMAGE_EXTENSIONS if kind == "photo" else VIDEO_EXTENSIONS
    if extension not in allowed:
        raise BadRequest(f"ad.media[].path does not look like a {kind} ({extension or 'no extension'})")
    size = os.path.getsize(real)
    if size <= 0 or size > MAX_MEDIA_BYTES:
        raise BadRequest("ad.media[].path is empty or larger than Telegram allows")
    return real, size


@dataclass(frozen=True)
class MediaItem:
    path: str  # already resolved with os.path.realpath and confined to the media root
    kind: str  # "photo" | "video"


@dataclass(frozen=True)
class Ad:
    html: str
    media: tuple[MediaItem, ...] = ()
    button_text: str | None = None
    button_url: str | None = None


@dataclass(frozen=True)
class SendPlan:
    """What to send, in order. Exactly one of the following shapes:

    text only       media == (),  caption_html is None, text_html is the message
    media + caption media != (),  caption_html is the caption, text_html is None
    media, then text media != (),  caption_html is None, text_html is sent as a reply to the
                                   first media message
    The button, when given, rides on the message that carries the text.
    """

    media: tuple[MediaItem, ...]
    caption_html: str | None
    text_html: str | None
    button_text: str | None
    button_url: str | None


def build_ad(
    html: object,
    media: list[tuple[str, str]],
    button_text: str | None,
    button_url: str | None,
    media_root: str | None,
) -> Ad:
    """Validate an ad (raises BadRequest) and confine its media to the media root."""
    visible = visible_text(html)  # type: ignore[arg-type]
    if utf16_length(visible) > MESSAGE_LIMIT:
        raise BadRequest(f"ad.html has {utf16_length(visible)} characters; Telegram allows {MESSAGE_LIMIT}")
    if len(media) > MAX_MEDIA:
        raise BadRequest(f"ad.media: Telegram allows at most {MAX_MEDIA} items per post")
    items = tuple(MediaItem(resolve_media_path(path, kind, media_root)[0], kind) for path, kind in media)
    if (button_text is None) != (button_url is None):
        raise BadRequest("ad.buttonText and ad.buttonUrl must be given together")
    if button_text is not None:
        if not button_text.strip() or len(button_text) > BUTTON_TEXT_MAX:
            raise BadRequest(f"ad.buttonText must be 1-{BUTTON_TEXT_MAX} characters")
        if not is_http_url(button_url or ""):
            raise BadRequest("ad.buttonUrl must be an http(s) URL")
        if len(items) > 1:
            raise BadRequest("ad.buttonText cannot be combined with more than one media item")
    return Ad(html=html, media=items, button_text=button_text, button_url=button_url)  # type: ignore[arg-type]


def plan_send(ad: Ad) -> SendPlan:
    """Split an ad exactly like the Bot API provider does."""
    visible = utf16_length(visible_text(ad.html))
    if not ad.media:
        return SendPlan((), None, ad.html, ad.button_text, ad.button_url)
    if visible <= CAPTION_LIMIT:
        return SendPlan(ad.media, ad.html, None, ad.button_text, ad.button_url)
    return SendPlan(ad.media, None, ad.html, ad.button_text, ad.button_url)


def release_url(username: str | None, message_id: str) -> str | None:
    """Public link to a sent message; None for communities without a username."""
    return f"https://t.me/{username}/{message_id}" if username else None
