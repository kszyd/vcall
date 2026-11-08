#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 Docker Hub 凭据写入 GitHub Actions Secrets（libsodium sealed box 加密）。

用法（不要在命令行明文传参）：
    set GH_TOKEN=...
    set DOCKERHUB_USERNAME=kszyd
    set DOCKERHUB_TOKEN=...
    python scripts/set_github_secrets.py
"""

import base64
import json
import os
import sys
import urllib.request

try:
    from nacl import encoding, public
except ImportError:
    print("缺少 pynacl：pip install pynacl", file=sys.stderr)
    sys.exit(1)

REPO = os.environ.get("GH_REPO", "kszyd/vcall")
TOKEN = os.environ.get("GH_TOKEN", "")
SECRETS = {
    "DOCKERHUB_USERNAME": os.environ.get("DOCKERHUB_USERNAME", ""),
    "DOCKERHUB_TOKEN": os.environ.get("DOCKERHUB_TOKEN", ""),
}


def api(path, method="GET", payload=None):
    url = f"https://api.github.com{path}"
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Authorization", f"Bearer {TOKEN}")
    request.add_header("Accept", "application/vnd.github+json")
    request.add_header("User-Agent", "vcall-setup")
    if data is not None:
        request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=30) as response:
        body = response.read().decode("utf-8")
        return json.loads(body) if body else {}


def main():
    if not TOKEN:
        print("缺少 GH_TOKEN", file=sys.stderr)
        return 1
    missing = [name for name, value in SECRETS.items() if not value]
    if missing:
        print("缺少环境变量：" + ", ".join(missing), file=sys.stderr)
        return 1

    key = api(f"/repos/{REPO}/actions/secrets/public-key")
    sealed_box = public.SealedBox(public.PublicKey(key["key"].encode(), encoding.Base64Encoder()))

    for name, value in SECRETS.items():
        encrypted = base64.b64encode(sealed_box.encrypt(value.encode("utf-8"))).decode()
        api(
            f"/repos/{REPO}/actions/secrets/{name}",
            method="PUT",
            payload={"encrypted_value": encrypted, "key_id": key["key_id"]},
        )
        print(f"已设置 secret: {name}")

    print("完成")
    return 0


if __name__ == "__main__":
    sys.exit(main())
