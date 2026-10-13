"""Sending: ad validation, media confined to AGENCYOS_MEDIA_ROOT, the exact caption/message split,
and the errors a send can end in. The split is also tested directly on ads.plan_send."""

import asyncio
import os
import sys

import pytest
from harness import ACCOUNT, WorkerHarness

from agencyos_telegram import ads
from agencyos_telegram.errors import BadRequest, OUTCOME_UNKNOWN, WorkerError
from agencyos_telegram.fake_backend import MemoryBackend
from agencyos_telegram.models import KIND_SUPERGROUP, Community

NEWS = "@agencyos_news"
CHAT = "@agencyos_chat"
PHOTO_BYTES = b"\xff\xd8\xff\xe0" + b"0" * 100


def ad_body(ref=NEWS, **ad):
    return {"account": ACCOUNT, "ref": ref, "ad": {"html": "Hello <b>world</b>", **ad}}


@pytest.fixture
def media(worker):
    root = worker.media_root

    def make(name="a.jpg", data=PHOTO_BYTES):
        path = os.path.join(root, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as handle:
            handle.write(data)
        return path

    return make


# ---- success shapes ------------------------------------------------------------------------------------
def test_text_only_send(worker, backend):
    response = worker.post("/v1/messages/send", ad_body())
    assert response.status == 200 and response.ok
    ids = response.body["messageIds"]
    assert len(ids) == 1 and response.body["primaryMessageId"] == ids[0]
    assert response.body["releaseUrl"] == f"https://t.me/agencyos_news/{ids[0]}"
    owner, plan = backend.outbox[0]
    assert plan.text_html == "Hello <b>world</b>" and plan.caption_html is None and plan.media == ()


def test_release_url_is_null_for_a_community_without_a_username(worker, backend):
    private = Community("555", KIND_SUPERGROUP, "Private", None, None, None, 3)
    backend.add_community(private, invite_hash="PrivateHash0001", owner=ACCOUNT["session"], admins={ACCOUNT["session"]})
    response = worker.post("/v1/messages/send", ad_body(ref="https://t.me/+PrivateHash0001"))
    assert response.ok and response.body["releaseUrl"] is None


def test_single_media_with_a_caption(worker, backend, media):
    path = media()
    response = worker.post("/v1/messages/send", ad_body(media=[{"path": path, "kind": "photo"}]))
    assert response.ok and len(response.body["messageIds"]) == 1
    plan = backend.outbox[0][1]
    assert plan.caption_html == "Hello <b>world</b>" and plan.text_html is None
    assert plan.media[0].path == os.path.realpath(path) and plan.media[0].kind == "photo"


def test_album_with_a_caption(worker, backend, media):
    items = [{"path": media(f"{i}.jpg"), "kind": "photo"} for i in range(3)] + [
        {"path": media("v.mp4"), "kind": "video"}
    ]
    response = worker.post("/v1/messages/send", ad_body(media=items))
    assert response.ok and len(response.body["messageIds"]) == 4
    assert backend.outbox[0][1].caption_html is not None


def test_long_text_goes_after_the_media_as_a_reply(worker, backend, media):
    long_text = "a" * 1025
    response = worker.post(
        "/v1/messages/send", ad_body(html=long_text, media=[{"path": media(), "kind": "photo"}])
    )
    assert response.ok and len(response.body["messageIds"]) == 2  # photo, then the text
    plan = backend.outbox[0][1]
    assert plan.caption_html is None and plan.text_html == long_text


def test_relative_media_paths_resolve_inside_the_root(worker, backend, media):
    media("sub/pic.png")
    response = worker.post("/v1/messages/send", ad_body(media=[{"path": "sub/pic.png", "kind": "photo"}]))
    assert response.ok


# ---- ad validation -------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "html",
    [
        "<script>alert(1)</script>", "line<br>break", '<img src="x">', "<div>x</div>", "<a>no href</a>",
        '<a href="javascript:alert(1)">x</a>', '<a href="tg://user?id=1">mention</a>',
        '<a href="https://ok.example" onclick="x()">x</a>', '<a href="ftp://x.example">x</a>',
        "<b>unclosed", "</b>stray", "<b><i>crossed</b></i>", '<b class="x">x</b>', "<b/>", "<!-- c -->x",
        "<?php x ?>x", "<!DOCTYPE html>x", "<tg-spoiler>x</tg-spoiler>", "<strong>x</strong>",
        '<code class="evil">x</code>', "<pre onclick='x'>x</pre>", "   ", "", "<b></b>",
    ],
)
def test_html_outside_the_allowed_subset_is_refused(worker, html):
    response = worker.post("/v1/messages/send", ad_body(html=html))
    assert response.status == 400 and response.error["code"] == "BAD_REQUEST", html


@pytest.mark.parametrize(
    "html",
    [
        "<b>bold</b> <i>it</i> <u>un</u> <s>st</s> <code>c</code> <pre>p</pre>",
        '<a href="https://example.com/x?y=1&amp;z=2">link</a>',
        '<pre><code class="language-python">print(1)</code></pre>',
        "a &lt; b &amp; c &gt; d", "plain text with emoji \U0001F600", "multi\nline\n\ntext",
    ],
)
def test_allowed_html_is_accepted(worker, html):
    assert worker.post("/v1/messages/send", ad_body(html=html)).ok


def test_message_and_caption_limits(worker, media):
    assert worker.post("/v1/messages/send", ad_body(html="a" * 4096)).ok
    too_long = worker.post("/v1/messages/send", ad_body(html="a" * 4097))
    assert too_long.status == 400 and "4096" in too_long.error["message"]
    # the limit counts visible characters, not markup
    assert worker.post("/v1/messages/send", ad_body(html="<b>" + "a" * 4096 + "</b>")).ok
    assert worker.post("/v1/messages/send", ad_body(html="&amp;" * 4096)).ok
    # and UTF-16 units, as Telegram does: an emoji is two
    assert worker.post("/v1/messages/send", ad_body(html="\U0001F600" * 2048)).ok
    assert worker.post("/v1/messages/send", ad_body(html="\U0001F600" * 2049)).status == 400


def test_caption_boundary_is_exact():
    def plan(visible: int, media=True):
        item = (ads.MediaItem("/tmp/x.jpg", "photo"),) if media else ()
        return ads.plan_send(ads.Ad("a" * visible, item))

    assert plan(1024).caption_html is not None and plan(1024).text_html is None
    assert plan(1025).caption_html is None and plan(1025).text_html is not None
    assert plan(1024, media=False).text_html is not None and plan(1024, media=False).caption_html is None
    markup = ads.plan_send(ads.Ad("<b>" + "a" * 1024 + "</b>", (ads.MediaItem("/tmp/x.jpg", "photo"),)))
    assert markup.caption_html is not None  # tags do not count
    emoji = ads.plan_send(ads.Ad("\U0001F600" * 512, (ads.MediaItem("/tmp/x.jpg", "photo"),)))
    assert emoji.caption_html is not None
    emoji = ads.plan_send(ads.Ad("\U0001F600" * 513, (ads.MediaItem("/tmp/x.jpg", "photo"),)))
    assert emoji.caption_html is None


def test_ad_shape_errors(worker, media):
    path = media()
    bad_ads = [
        None, "text", {}, {"html": 5}, {"html": "x", "media": "a.jpg"}, {"html": "x", "extra": 1},
        {"html": "x", "media": [{"path": path}]},
        {"html": "x", "media": [{"path": path, "kind": "gif"}]},
        {"html": "x", "media": [{"path": path, "kind": "photo", "extra": 1}]},
        {"html": "x", "media": [path]},
        {"html": "x", "media": [{"path": path, "kind": "photo"}] * 11},
        {"html": "x" * 40000},
    ]
    for ad in bad_ads:
        response = worker.post("/v1/messages/send", {"account": ACCOUNT, "ref": NEWS, "ad": ad})
        assert response.status == 400, ad


# ---- media confinement ------------------------------------------------------------------------------------------------
def test_media_outside_the_root_is_refused(worker, tmp_path, media):
    outside = tmp_path / "outside.jpg"
    outside.write_bytes(PHOTO_BYTES)
    media("inside.jpg")
    for path in (str(outside), "../outside.jpg", "sub/../../outside.jpg", os.path.join(worker.media_root, "..", "outside.jpg")):
        response = worker.post("/v1/messages/send", ad_body(media=[{"path": path, "kind": "photo"}]))
        assert response.status == 400, path
        assert "outside the media root" in response.error["message"]
    assert worker.backend.outbox == []


@pytest.mark.skipif(sys.platform == "win32", reason="creating symlinks needs privileges on Windows")
def test_a_symlink_inside_the_root_cannot_escape_it(worker, tmp_path):
    (tmp_path / "secret.jpg").write_bytes(PHOTO_BYTES)
    os.symlink(tmp_path / "secret.jpg", os.path.join(worker.media_root, "link.jpg"))
    response = worker.post("/v1/messages/send", ad_body(media=[{"path": "link.jpg", "kind": "photo"}]))
    assert response.status == 400 and "outside the media root" in response.error["message"]


def test_media_must_be_an_existing_file_of_the_right_kind(worker, media):
    media("movie.mp4")
    media("pic.jpg")
    os.makedirs(os.path.join(worker.media_root, "folder.jpg"))
    media("empty.jpg", b"")
    media("notes.txt", b"hello")
    cases = [
        ("missing.jpg", "photo"), ("folder.jpg", "photo"), ("empty.jpg", "photo"), ("notes.txt", "photo"),
        ("movie.mp4", "photo"), ("pic.jpg", "video"),
    ]
    for path, kind in cases:
        response = worker.post("/v1/messages/send", ad_body(media=[{"path": path, "kind": kind}]))
        assert response.status == 400, (path, kind)
    assert worker.post("/v1/messages/send", ad_body(media=[{"path": "movie.mp4", "kind": "video"}])).ok


def test_media_is_refused_when_no_media_root_is_configured():
    harness = WorkerHarness(MemoryBackend.with_demo_data(), media_root=None).start()
    try:
        response = harness.post(
            "/v1/messages/send", ad_body(media=[{"path": "/etc/hostname", "kind": "photo"}])
        )
        assert response.status == 400 and "AGENCYOS_MEDIA_ROOT" in response.error["message"]
        assert harness.post("/v1/messages/send", ad_body()).ok  # text still works
    finally:
        harness.stop()


def test_nul_in_a_path_is_refused(worker):
    response = worker.post("/v1/messages/send", ad_body(media=[{"path": "a.jpg\x00.png", "kind": "photo"}]))
    assert response.status == 400


# ---- the button -------------------------------------------------------------------------------------------------------------
def test_button_needs_text_and_an_http_url(worker, backend):
    ok = worker.post("/v1/messages/send", ad_body(buttonText="Open", buttonUrl="https://example.com/offer"))
    assert ok.ok
    plan = backend.outbox[0][1]
    assert (plan.button_text, plan.button_url) == ("Open", "https://example.com/offer")
    bad = [
        {"buttonText": "Open"}, {"buttonUrl": "https://example.com"},
        {"buttonText": "Open", "buttonUrl": "javascript:alert(1)"},
        {"buttonText": "Open", "buttonUrl": "tg://resolve?domain=x"},
        {"buttonText": "Open", "buttonUrl": "https://exa mple.com"},
        {"buttonText": "Open", "buttonUrl": "ftp://example.com/a"},
        {"buttonText": "", "buttonUrl": "https://example.com"},
        {"buttonText": "x" * 65, "buttonUrl": "https://example.com"},
        {"buttonText": "Open", "buttonUrl": "https://example.com/" + "a" * 600},
    ]
    for extra in bad:
        assert worker.post("/v1/messages/send", ad_body(**extra)).status == 400, extra


def test_button_cannot_ride_on_an_album(worker, media):
    items = [{"path": media(f"{i}.jpg"), "kind": "photo"} for i in range(2)]
    response = worker.post(
        "/v1/messages/send", ad_body(media=items, buttonText="Open", buttonUrl="https://example.com")
    )
    assert response.status == 400


# ---- what a send can end in ----------------------------------------------------------------------------------------------------
def test_sending_where_the_account_may_not_write(worker, backend):
    backend.add_account("other-session")
    other = {**ACCOUNT, "session": "other-session"}
    channel = worker.post("/v1/messages/send", {"account": other, "ref": NEWS, "ad": {"html": "hi"}})
    assert channel.status == 200 and channel.error["code"] == "FORBIDDEN"  # not an admin of a broadcast channel
    group = worker.post("/v1/messages/send", {"account": other, "ref": CHAT, "ad": {"html": "hi"}})
    assert group.error["code"] == "FORBIDDEN"  # not a member
    assert backend.outbox == []


def test_a_restricted_account_is_reported_and_nothing_is_retried(worker, backend):
    backend.accounts[ACCOUNT["session"]].restricted = True
    response = worker.post("/v1/messages/send", ad_body())
    assert response.error["code"] == "ACCOUNT_RESTRICTED"
    assert backend.calls.count("send_ad") == 1 and backend.outbox == []


def test_a_flood_wait_is_returned_never_slept_through(worker, backend):
    backend.rate_limit_next("send_ad", 3600)
    response = worker.post("/v1/messages/send", ad_body())
    assert response.error["code"] == "RATE_LIMITED" and response.error["retryAfterSeconds"] == 3600
    assert worker.clock.sleeps == [] and backend.calls.count("send_ad") == 1


def test_an_interrupted_send_is_outcome_unknown_and_not_repeated(worker, backend):
    backend.fail_next("send_ad", WorkerError(OUTCOME_UNKNOWN, "The connection was interrupted while sending."))
    response = worker.post("/v1/messages/send", ad_body())
    assert response.status == 200 and response.error["code"] == "OUTCOME_UNKNOWN"
    assert backend.calls.count("send_ad") == 1


def test_a_send_that_times_out_is_outcome_unknown_and_other_calls_are_network():
    backend = MemoryBackend.with_demo_data()
    harness = WorkerHarness(
        backend, service_options={"send_timeout": 0.2, "operation_timeout": 0.2}
    ).start()
    try:
        async def make_gate():
            backend.gate = asyncio.Event()  # never opened: the backend hangs

        harness.run_in_loop(make_gate())
        sent = harness.post("/v1/messages/send", ad_body())
        assert sent.status == 200 and sent.error["code"] == "OUTCOME_UNKNOWN"
        looked_up = harness.post("/v1/communities/resolve", {"account": ACCOUNT, "ref": NEWS})
        assert looked_up.error["code"] == "NETWORK"
        assert harness.post("/v1/messages/send", ad_body()).error["code"] == "OUTCOME_UNKNOWN"
        # creating a community is not repeatable either: a timeout there is an unknown outcome too
        created = harness.post("/v1/communities/create", {"account": ACCOUNT, "kind": "group", "title": "t"})
        assert created.error["code"] == "OUTCOME_UNKNOWN"
        assert backend.outbox == []
    finally:
        harness.stop()


# ---- direct tests of the helpers ---------------------------------------------------------------------------------------------------
def test_visible_text_and_utf16_length():
    assert ads.visible_text("  <b>Hi</b> &amp; <i>bye</i>  ") == "Hi & bye"
    assert ads.utf16_length("a\U0001F600") == 3
    with pytest.raises(BadRequest):
        ads.visible_text("<b>x</i>")


def test_release_url():
    assert ads.release_url("name", "12") == "https://t.me/name/12"
    assert ads.release_url(None, "12") is None
