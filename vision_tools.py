#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
视觉工具链（OpenCV）—— 为「纹样再设计 / AI 共创」提供结构化视觉分析。

提供两个工具：
    extract_color(image_path)      主色板提取（Hex + 像素占比）
    segment_pattern(image_path)    边缘 + 连通域图层切分（第一版，粗糙但可跑）

并导出 OpenAI 风格的 Function Calling Schema（VISION_TOOLS），
供后续让 GLM 自主决定调用哪个工具。
依赖：opencv-python-headless（cv2）、numpy、pillow（webp 等格式兼容读取）。
"""
import os
import cv2
import numpy as np


# --------------------------------------------------------------------------- #
# 0) 格式无关的图片读取（WebP 兼容补丁）
# --------------------------------------------------------------------------- #
def _load_rgb(image_path: str) -> np.ndarray:
    """
    鲁棒地把任意格式图片读为 RGB numpy 数组。

    OpenCV 的 cv2.imread 对 .webp / 带透明通道 PNG 等经常返回 None，
    这里优先用 cv2（jpg/png 最快），失败则回退 Pillow（原生支持 webp 等所有格式）。
    这样「AI 共创」上传的图片不管什么格式都能稳提取颜色与切分图层。
    """
    if not os.path.isfile(image_path):
        raise FileNotFoundError(image_path)
    # 1) 先试 OpenCV（绝大多数情况足够）
    img = cv2.imread(image_path)
    if img is not None:
        return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    # 2) 回退 Pillow：原生支持 webp / 带 alpha 的 png / 各种罕见编码
    try:
        from PIL import Image
        with Image.open(image_path) as im:
            return np.asarray(im.convert("RGB"))
    except Exception as e:
        raise ValueError(f"无法解码图片（cv2 与 PIL 均失败）: {image_path} | {e}")


# --------------------------------------------------------------------------- #
# 1) 主色板提取
# --------------------------------------------------------------------------- #
def extract_color(image_path: str, k: int = 5) -> dict:
    """
    用 K-Means 对像素聚类，返回主色板。
    返回:
        {
          "image_path": ..., "k": k,
          "palette": [ {"hex":"#RRGGBB","rgb":[r,g,b],"ratio":0.xx}, ... ]  # 按占比降序
        }
    """
    img = _load_rgb(image_path)
    h, w = img.shape[:2]
    # 缩放以加速（不影响主色判断）
    if max(h, w) > 512:
        scale = 512.0 / max(h, w)
        img = cv2.resize(img, (int(w * scale), int(h * scale)))
    pixels = img.reshape(-1, 3).astype(np.float32)

    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 100, 0.2)
    _, labels, centers = cv2.kmeans(
        pixels, k, None, criteria, 10, cv2.KMEANS_PP_CENTERS
    )
    counts = np.bincount(labels.flatten(), minlength=k)
    total = float(counts.sum())

    order = counts.argsort()[::-1]  # 占比降序
    palette = []
    for i in order:
        r, g, b = (int(round(c)) for c in centers[i])
        palette.append({
            "hex": "#%02X%02X%02X" % (r, g, b),
            "rgb": [r, g, b],
            "ratio": round(float(counts[i]) / total, 4),
        })

    return {
        "image_path": image_path,
        "k": k,
        "palette": palette,
        "dominant": palette[0]["hex"] if palette else None,
    }


# --------------------------------------------------------------------------- #
# 2) 图层切分（边缘 + 连通域）
# --------------------------------------------------------------------------- #
def segment_pattern(image_path: str, min_area_ratio: float = 0.002) -> dict:
    """
    第一版：Canny 边缘 → 膨胀闭合 → 连通域标记，把图像切成若干「图层」。
    返回:
        {
          "image_path": ..., "edge_pixels": int, "num_components": int,
          "layers": [ {"label":i,"bbox":[x,y,w,h],"area":int,"area_ratio":0.xx}, ... ]  # 按面积降序
        }
    """
    if not os.path.isfile(image_path):
        raise FileNotFoundError(image_path)
    rgb = _load_rgb(image_path)
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)

    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blur, 50, 150)
    kernel = np.ones((3, 3), np.uint8)
    edges = cv2.dilate(edges, kernel, iterations=1)

    # 反相后做连通域：线条变黑、色块变白，连通域即「图层」
    inv = cv2.bitwise_not(edges)
    num_labels, _, stats, _ = cv2.connectedComponentsWithStats(inv, connectivity=8)

    h, w = gray.shape
    total = float(h * w)
    layers = []
    for i in range(1, num_labels):  # 0 为背景
        x, y, bw, bh, area = stats[i]
        if area / total < min_area_ratio:
            continue
        layers.append({
            "label": int(i),
            "bbox": [int(x), int(y), int(bw), int(bh)],
            "area": int(area),
            "area_ratio": round(area / total, 4),
        })
    layers.sort(key=lambda d: d["area"], reverse=True)

    return {
        "image_path": image_path,
        "edge_pixels": int(edges.sum() // 255),
        "num_components": len(layers),
        "layers": layers,
    }


# --------------------------------------------------------------------------- #
# 3) Function Calling Schema（供模型自主调用）
# --------------------------------------------------------------------------- #
EXTRACT_COLOR_SCHEMA = {
    "type": "function",
    "function": {
        "name": "extract_color",
        "description": "从一张纹样图片中提取主色板，返回每个主色的 Hex 色值与像素占比。"
                       "适用于「提取配色」「找某色系纹样」「分析这张图的色彩」等需求。",
        "parameters": {
            "type": "object",
            "properties": {
                "image_path": {
                    "type": "string",
                    "description": "待分析图片的本地绝对路径",
                }
            },
            "required": ["image_path"],
        },
    },
}

SEGMENT_PATTERN_SCHEMA = {
    "type": "function",
    "function": {
        "name": "segment_pattern",
        "description": "对纹样图片做边缘检测与连通域切分，返回若干图层（含包围盒与面积占比）。"
                       "适用于「拆解这个纹样的结构」「分层/抠图再设计」等需求。",
        "parameters": {
            "type": "object",
            "properties": {
                "image_path": {
                    "type": "string",
                    "description": "待分析图片的本地绝对路径",
                }
            },
            "required": ["image_path"],
        },
    },
}

# 组合列表，可直接传给支持 tools 的对话接口
VISION_TOOLS = [EXTRACT_COLOR_SCHEMA, SEGMENT_PATTERN_SCHEMA]


if __name__ == "__main__":
    import json
    import sys

    p = sys.argv[1] if len(sys.argv) > 1 else "A01.webp"
    print("=== extract_color ===")
    print(json.dumps(extract_color(p), ensure_ascii=False, indent=2))
    print("=== segment_pattern ===")
    print(json.dumps(segment_pattern(p), ensure_ascii=False, indent=2))
