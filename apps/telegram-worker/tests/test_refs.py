import pytest

from agencyos_telegram.errors import INVALID_REF, WorkerError
from agencyos_telegram.refs import INVITE, USERNAME, Ref, parse_ref


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("@durov", Ref(USERNAME, "durov")),
        ("durov", Ref(USERNAME, "durov")),
        ("  @Durov_Official  ", Ref(USERNAME, "Durov_Official")),
        ("https://t.me/durov", Ref(USERNAME, "durov")),
        ("http://t.me/durov", Ref(USERNAME, "durov")),
        ("t.me/durov", Ref(USERNAME, "durov")),
        ("telegram.me/durov", Ref(USERNAME, "durov")),
        ("https://telegram.dog/durov/", Ref(USERNAME, "durov")),
        ("https://T.ME/durov?start=abc#frag", Ref(USERNAME, "durov")),
        ("https://t.me/durov/123", Ref(USERNAME, "durov")),  # a message link names its community
        ("https://t.me/s/durov", Ref(USERNAME, "durov")),
        ("tg://resolve?domain=durov", Ref(USERNAME, "durov")),
        ("https://t.me/+AbCdEfGhIjKlMnOp", Ref(INVITE, "AbCdEfGhIjKlMnOp")),
        ("t.me/+AbCdEfGhIjKlMnOp", Ref(INVITE, "AbCdEfGhIjKlMnOp")),
        ("https://t.me/joinchat/AbCdEfGhIjKlMnOpQrStUv", Ref(INVITE, "AbCdEfGhIjKlMnOpQrStUv")),
        ("https://t.me/joinchat/AbCd-EfGh_IjKlMnOp", Ref(INVITE, "AbCd-EfGh_IjKlMnOp")),
        ("tg://join?invite=AbCdEfGhIjKlMnOp", Ref(INVITE, "AbCdEfGhIjKlMnOp")),
        ("a" + "b" * 30 + "c", Ref(USERNAME, "a" + "b" * 30 + "c")),  # 32 characters
    ],
)
def test_valid_refs(text, expected):
    assert parse_ref(text) == expected


@pytest.mark.parametrize(
    "text",
    [
        "", "   ", "@", "@@durov", "abc", "1abcde", "_abcde", "abcde_", "ab cd", "a-b-c-d", "durov!",
        "+4915112345678", "49151 1234567", "+AbCdEfGhIjKlMnOp",  # a bare invite hash is not a ref
        "https://example.com/durov", "https://t.me", "https://t.me/", "https://t.me//durov",
        "https://t.me/durov/abc", "https://t.me/durov/1/2", "https://t.me/c/1234567/89",
        "https://t.me/addstickers/Pack", "https://t.me/proxy?server=x", "https://t.me/share/url?url=x",
        "https://t.me/joinchat/", "https://t.me/joinchat/short", "https://t.me/+short",
        "https://t.me/joinchat/abc/def", "https://user@t.me/durov", "https://t.me:8443/durov",
        "ftp://t.me/durov", "javascript:alert(1)", "tg://user?id=1", "tg://resolve?domain=a&domain=b",
        "tg://resolve", "tg://join", "https://t.me/durov\nhttps://t.me/other", "durov\x00",
        "<b>durov</b>", '"durov"', "a" * 33, "https://t.me/" + "a" * 300,
        None, 5, ["durov"], {"ref": "durov"}, True,
    ],
)
def test_invalid_refs(text):
    with pytest.raises(WorkerError) as caught:
        parse_ref(text)
    assert caught.value.code == INVALID_REF


def test_invite_refs_are_flagged():
    assert parse_ref("t.me/+AbCdEfGhIjKlMnOp").is_invite
    assert not parse_ref("durov").is_invite
