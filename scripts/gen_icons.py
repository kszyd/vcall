#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 VCall 安卓启动图标与电视 banner（纯标准库，无 Pillow 依赖）。"""

import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, "android", "app", "src", "main", "res")

FONT = {
    "V": ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
    "C": ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
    "a": ["00000", "00000", "01110", "00001", "01111", "10001", "01111"],
    "l": ["00100", "00100", "00100", "00100", "00100", "00100", "00110"],
}


def write_png(path, width, height, pixels):
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)
        raw.extend(pixels[y * stride:(y + 1) * stride])

    def chunk(tag, data):
        out = struct.pack(">I", len(data)) + tag + data
        return out + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", header)
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(png)
    print("wrote", os.path.relpath(path, ROOT), f"{width}x{height}")


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def in_rounded_rect(u, v, x0, y0, x1, y1, radius):
    if u < x0 or u > x1 or v < y0 or v > y1:
        return False
    r = min(radius, (x1 - x0) / 2, (y1 - y0) / 2)
    cx = min(max(u, x0 + r), x1 - r)
    cy = min(max(v, y0 + r), y1 - r)
    dx = u - cx
    dy = v - cy
    return dx * dx + dy * dy <= r * r


def icon_shade(u, v):
    """图标：青蓝渐变圆角底 + 白色摄像机。"""
    if not in_rounded_rect(u, v, 0.0, 0.0, 1.0, 1.0, 0.23):
        return (0, 0, 0, 0)

    t = (u + v) / 2.0
    bg = lerp((34, 211, 238), (59, 130, 246), t)

    # 摄像机机身
    if in_rounded_rect(u, v, 0.19, 0.33, 0.615, 0.67, 0.075):
        # 镜头圆点
        dx = u - 0.40
        dy = v - 0.50
        if dx * dx + dy * dy <= 0.088 * 0.088:
            return (37, 99, 235, 255)
        return (255, 255, 255, 255)

    # 镜头梯形
    if 0.615 <= u <= 0.80 and 0.36 <= v <= 0.64:
        progress = (u - 0.615) / (0.80 - 0.615)
        half = 0.14 * (1.0 - 0.62 * progress)
        if abs(v - 0.5) <= half:
            return (255, 255, 255, 255)

    return bg + (255,)


def banner_text_layout(width, height):
    """计算 banner 中图标与「VCall」文字的布局（整体居中，避免溢出）。"""
    text = "VCall"
    total_cols = sum(len(FONT[ch][0]) for ch in text) + (len(text) - 1)
    cell = min(height * 0.052, (width * 0.40) / total_cols)
    text_width = total_cols * cell
    icon_size = height * 0.44
    gap = height * 0.10
    total_width = icon_size + gap + text_width
    start_all = (width - total_width) / 2.0
    icon_x0 = start_all
    text_x = start_all + icon_size + gap
    icon_y0 = (height - icon_size) / 2.0
    start_y = (height - 7 * cell) / 2.0

    columns = []
    for ch in text:
        for col in range(len(FONT[ch][0])):
            columns.append((ch, col))
        columns.append(None)  # 字符间距
    return icon_x0, icon_y0, icon_size, text_x, start_y, cell, columns


def banner_shade_factory(width, height):
    icon_x0, icon_y0, icon_size, start_x, start_y, cell, columns = banner_text_layout(width, height)

    def shade(u, v):
        px = u * width
        py = v * height

        # 背景渐变
        bg = lerp((8, 13, 24), (18, 30, 52), v)
        color = bg + (255,)

        # 左侧图标
        if icon_x0 <= px <= icon_x0 + icon_size and icon_y0 <= py <= icon_y0 + icon_size:
            iu = (px - icon_x0) / icon_size
            iv = (py - icon_y0) / icon_size
            pixel = icon_shade(iu, iv)
            if pixel[3] > 0:
                return pixel

        # 文字
        if px >= start_x and py >= start_y:
            col_index = int((px - start_x) / cell)
            row_index = int((py - start_y) / cell)
            if 0 <= row_index < 7 and 0 <= col_index < len(columns):
                entry = columns[col_index]
                if entry is not None:
                    ch, col = entry
                    if FONT[ch][row_index][col] == "1":
                        return (233, 238, 251, 255)
        return color

    return shade


def render(path, width, height, shade, supersample=3):
    pixels = bytearray(width * height * 4)
    inv = 1.0 / (supersample * supersample)
    for y in range(height):
        for x in range(width):
            r = g = b = a = 0.0
            for sy in range(supersample):
                for sx in range(supersample):
                    u = (x + (sx + 0.5) / supersample) / width
                    v = (y + (sy + 0.5) / supersample) / height
                    pr, pg, pb, pa = shade(u, v)
                    alpha = pa / 255.0
                    r += pr * alpha
                    g += pg * alpha
                    b += pb * alpha
                    a += pa
            alpha_avg = a * inv / 255.0
            if alpha_avg > 0:
                r = r * inv / alpha_avg
                g = g * inv / alpha_avg
                b = b * inv / alpha_avg
            idx = (y * width + x) * 4
            pixels[idx] = min(255, max(0, int(r)))
            pixels[idx + 1] = min(255, max(0, int(g)))
            pixels[idx + 2] = min(255, max(0, int(b)))
            pixels[idx + 3] = min(255, max(0, int(a * inv)))
    write_png(path, width, height, pixels)


def main():
    sizes = {
        "mipmap-mdpi": 48,
        "mipmap-hdpi": 72,
        "mipmap-xhdpi": 96,
        "mipmap-xxhdpi": 144,
        "mipmap-xxxhdpi": 192,
    }
    for folder, size in sizes.items():
        render(os.path.join(RES, folder, "ic_launcher.png"), size, size, icon_shade)

    render(os.path.join(RES, "drawable", "tv_banner.png"), 320, 180,
           banner_shade_factory(320, 180))


if __name__ == "__main__":
    main()
