"""
PaddleOCR Bridge for Node.js
============================
Runs PaddleOCR on a given image and prints JSON output for Node.js.

Usage:
    python deepseek_ocr.py <image_path>
"""

import sys
import os
import json
import time

# Suppress PaddlePaddle / PaddleOCR noisy logs
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
os.environ.setdefault("GLOG_v", "0")
os.environ.setdefault("FLAGS_log_level", "3")


def try_paddleocr(image_path):
    """PaddleOCR — fast, accurate on stylized/decorative text."""
    from paddleocr import PaddleOCR

    print("[OCR] Loading PaddleOCR (PP-OCRv5)...", file=sys.stderr)
    start = time.time()
    ocr = PaddleOCR(lang="en")
    results = list(ocr.predict(image_path))
    elapsed = time.time() - start

    all_texts = []
    for res in results:
        texts = res.get("rec_texts", [])
        all_texts.extend(texts)

    text = " ".join(all_texts).strip()
    print(f"[OCR] PaddleOCR done in {elapsed:.1f}s — {len(text)} chars", file=sys.stderr)

    if text and len(text) > 5:
        return {
            "success": True,
            "text": text,
            "method": "paddleocr",
            "timeMs": int(elapsed * 1000),
        }
    return None


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "No image path provided", "text": ""}))
        sys.exit(1)

    image_path = sys.argv[1]
    if not os.path.isfile(image_path):
        print(json.dumps({"success": False, "error": f"File not found: {image_path}", "text": ""}))
        sys.exit(1)

    start = time.time()
    errors = []

    # ── PaddleOCR (only engine) ──
    try:
        result = try_paddleocr(image_path)
        if result:
            print(json.dumps(result))
            return
        errors.append("PaddleOCR returned empty text")
    except Exception as e:
        msg = str(e)
        print(f"[OCR] PaddleOCR failed: {msg}", file=sys.stderr)
        errors.append(f"PaddleOCR: {msg}")

    # ── OCR failed ──
    total = time.time() - start
    print(json.dumps({
        "success": False,
        "error": "; ".join(errors),
        "text": "",
        "timeMs": int(total * 1000),
    }))
    sys.exit(1)


if __name__ == "__main__":
    main()
