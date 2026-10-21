# -*- coding: utf-8 -*-
"""Hermes Remote Control - quick end-to-end smoke test.

Usage:  python -I test_smoke.py
Assumes: relay server running (node server/relay.js) + extension loaded.
"""
import json
import time
import urllib.request

BASE = "http://127.0.0.1:8766"


def call(path, data=None):
    url = BASE + path
    if data is None:
        req = urllib.request.Request(url)
    else:
        req = urllib.request.Request(
            url, data=json.dumps(data).encode(),
            headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def main():
    st = call("/status")
    print("[status]", st)
    assert st.get("extensionConnected"), "extension is NOT connected - load it in chrome://extensions"

    tabs = call("/tabs")
    print("[tabs]", [t.get("url") for t in tabs.get("tabs", [])][:5])

    tab = call("/tab/new", {"url": "https://example.com"})
    tab_id = tab["tabId"]
    print("[tab/new] tabId =", tab_id)
    time.sleep(2)

    title = call("/evaluate", {"expression": "document.title", "tabId": tab_id})
    print("[evaluate] title =", title)

    shot = call("/screenshot", {"tabId": tab_id})
    img = shot.get("image", "")
    print("[screenshot] got", len(img), "bytes data URL")

    call("/tab/close", {"tabId": tab_id})
    print("[tab/close] done - ALL OK")


if __name__ == "__main__":
    main()
