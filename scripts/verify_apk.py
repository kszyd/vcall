#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Validate VCall APK: structure, ABI native libs, signature block and classes."""

import os
import sys
import zipfile

EXPECTED_LIBS = [
    "lib/arm64-v8a/libjingle_peerconnection_so.so",
    "lib/armeabi-v7a/libjingle_peerconnection_so.so",
]


def mark(condition):
    return "OK  " if condition else "FAIL"


def check_zip(path):
    ok = True
    with zipfile.ZipFile(path) as apk:
        names = set(apk.namelist())
        print("[%s] entries: %d" % (os.path.basename(path), len(names)))

        for item in ["AndroidManifest.xml", "classes.dex", "resources.arsc"]:
            exists = item in names
            ok &= exists
            print("  %s %s" % (mark(exists), item))

        for lib in EXPECTED_LIBS:
            exists = lib in names
            ok &= exists
            size = apk.getinfo(lib).file_size // 1024 if exists else 0
            print("  %s %s (%d KB)" % (mark(exists), lib, size))

        dex_files = sorted(n for n in names if n.startswith("classes") and n.endswith(".dex"))
        print("  OK   dex: %s" % ", ".join(dex_files))

        certs = [
            n for n in names
            if n.upper().startswith("META-INF/") and n.upper().endswith((".RSA", ".DSA", ".EC"))
        ]
        ok &= bool(certs)
        print("  %s v1 cert: %s" % (mark(bool(certs)), certs or "none"))

        for probe in ["com/kszyd/vcall/MainActivity", "com/kszyd/vcall/CallSession"]:
            found = any(probe.encode() in apk.read(dex) for dex in dex_files)
            ok &= found
            print("  %s class %s" % (mark(found), probe))

        manifest = apk.read("AndroidManifest.xml")
        for keyword in ["com.kszyd.vcall", "android.software.leanback", "android.permission.CAMERA"]:
            # 二进制 AXML 的字符串池使用 UTF-16LE
            found = keyword.encode("utf-16-le") in manifest or keyword.encode() in manifest
            ok &= found
            print("  %s manifest %s" % (mark(found), keyword))

    with open(path, "rb") as handle:
        handle.seek(0, os.SEEK_END)
        size = handle.tell()
        handle.seek(max(0, size - 65536))
        tail = handle.read()
    # v2/v3 签名块位于中央目录之前，以 "APK Sig Block 42" 结尾
    v2 = b"APK Sig Block 42" in tail
    ok &= v2
    print("  %s APK Signature Scheme v2/v3 (%.1f MB)" % (mark(v2), size / 1048576.0))
    return ok


def main():
    targets = sys.argv[1:] or ["outputs/VCall-1.0.0-debug.apk", "outputs/VCall-1.0.0.apk"]
    results = []
    for target in targets:
        if not os.path.exists(target):
            print("missing: %s" % target)
            results.append(False)
            continue
        results.append(check_zip(target))
        print("")
    print("RESULT: " + ("ALL PASS" if all(results) else "FAILED"))
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
