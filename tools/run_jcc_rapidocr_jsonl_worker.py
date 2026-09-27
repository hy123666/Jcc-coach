import json
import sys
import time
import argparse
from pathlib import Path


def read_image(path):
    try:
        from PIL import Image
        return Image.open(path)
    except Exception as exc:
        raise RuntimeError(f"failed to open image: {path}: {exc}") from exc


def normalized_roi_to_pixels(image, roi):
    width, height = image.size
    x = round(float(roi.get("x", 0)) * width)
    y = round(float(roi.get("y", 0)) * height)
    w = round(float(roi.get("w", 1)) * width)
    h = round(float(roi.get("h", 1)) * height)
    x = max(0, min(x, width - 1))
    y = max(0, min(y, height - 1))
    w = max(1, min(w, width - x))
    h = max(1, min(h, height - y))
    return {"x": x, "y": y, "w": w, "h": h}


def apply_request_roi(image, request):
    normalized_roi = request.get("normalized_roi")
    if not normalized_roi:
        width, height = image.size
        return image, {"x": 0, "y": 0, "w": width, "h": height}
    roi = normalized_roi_to_pixels(image, normalized_roi)
    cropped = image.crop((roi["x"], roi["y"], roi["x"] + roi["w"], roi["y"] + roi["h"]))
    return cropped, roi


def create_ocr(config_path=None):
    try:
        from rapidocr import RapidOCR
    except Exception as exc:
        raise RuntimeError(f"failed to import RapidOCR: {exc}") from exc
    if config_path:
        return RapidOCR(config_path=str(Path(config_path).resolve()))
    return RapidOCR()


def warm_ocr(ocr):
    try:
        from PIL import Image, ImageDraw
    except Exception as exc:
        raise RuntimeError(f"failed to import PIL for OCR warmup: {exc}") from exc
    image = Image.new("RGB", (180, 52), "white")
    draw = ImageDraw.Draw(image)
    draw.text((8, 12), "JCC 123", fill=(0, 0, 0))
    started = time.perf_counter()
    raw = ocr(image)
    normalize_result(raw)
    return int((time.perf_counter() - started) * 1000)


def normalize_result(raw_result):
    if raw_result is None:
        return []
    if isinstance(raw_result, tuple) and raw_result:
        raw_result = raw_result[0]
    if hasattr(raw_result, "boxes") and hasattr(raw_result, "txts"):
        boxes = to_list(raw_result.boxes)
        texts = to_list(raw_result.txts)
        scores = to_list(raw_result.scores)
        blocks = []
        for idx, text in enumerate(texts):
            box = boxes[idx] if idx < len(boxes) else None
            score = scores[idx] if idx < len(scores) else None
            rect = polygon_to_rect(box)
            blocks.append({
                "text": str(text or ""),
                "confidence": float(score) if score is not None else None,
                "polygon": box,
                "rect": rect,
            })
        return blocks
    if hasattr(raw_result, "txts") and hasattr(raw_result, "scores"):
        texts = to_list(raw_result.txts)
        scores = to_list(raw_result.scores)
        return [
            {
                "text": str(text or ""),
                "confidence": float(scores[idx]) if idx < len(scores) and scores[idx] is not None else None,
                "polygon": None,
                "rect": None,
            }
            for idx, text in enumerate(texts)
        ]
    if isinstance(raw_result, list):
        blocks = []
        for entry in raw_result:
            if not isinstance(entry, (list, tuple)) or len(entry) < 2:
                continue
            box = entry[0]
            text = entry[1]
            score = entry[2] if len(entry) > 2 else None
            blocks.append({
                "text": str(text or ""),
                "confidence": float(score) if score is not None else None,
                "polygon": box,
                "rect": polygon_to_rect(box),
            })
        return blocks
    return []


def to_list(value):
    if value is None:
        return []
    if hasattr(value, "tolist"):
        return value.tolist()
    return list(value)


def polygon_to_rect(polygon):
    if not polygon:
        return None
    points = []
    for point in polygon:
        if isinstance(point, dict):
            points.append((float(point.get("x", 0)), float(point.get("y", 0))))
        elif isinstance(point, (list, tuple)) and len(point) >= 2:
            points.append((float(point[0]), float(point[1])))
    if not points:
        return None
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return {"x": min(xs), "y": min(ys), "w": max(xs) - min(xs), "h": max(ys) - min(ys)}


def handle_request(ocr, request):
    if request.get("type") == "ocr" and request.get("image"):
        image, applied_roi = apply_request_roi(read_image(request.get("image")), request)
        debug_output_image = request.get("debug_output_image")
        if debug_output_image:
            debug_path = Path(debug_output_image).resolve()
            debug_path.parent.mkdir(parents=True, exist_ok=True)
            image.save(debug_path)
        raw = ocr(
            image,
            use_det=request.get("use_det"),
            use_cls=request.get("use_cls"),
            use_rec=request.get("use_rec"),
            text_score=request.get("text_score"),
        )
        blocks = normalize_result(raw)
        return {
            "schema": "jcc-rapidocr-single-result-v1",
            "ok": True,
            "id": request.get("id"),
            "blocks": blocks,
            "text": "".join(block.get("text") or "" for block in blocks),
            "roi": applied_roi,
            "image_size": {"width": image.size[0], "height": image.size[1]},
            "debug_output_image": str(debug_path) if debug_output_image else None,
        }
    crops = request.get("crops") or []
    results = []
    for crop in crops:
        crop_image = crop.get("crop_image")
        result = {**crop, "ok": False, "ocr": {"ok": False, "blocks": []}}
        try:
            image = read_image(crop_image)
            raw = ocr(
                image,
                use_det=crop.get("use_det"),
                use_cls=crop.get("use_cls"),
                use_rec=crop.get("use_rec"),
                text_score=crop.get("text_score"),
            )
            blocks = normalize_result(raw)
            result["ok"] = True
            result["ocr"] = {
                "ok": True,
                "blocks": blocks,
                "text": "".join(block.get("text") or "" for block in blocks),
            }
        except Exception as exc:
            result["error"] = str(exc)
        results.append(result)
    return {
        "schema": "jcc-rapidocr-result-batch-v1",
        "ok": all(item.get("ok") for item in results),
        "crops": results,
    }


def main():
    parser = argparse.ArgumentParser(description="Resident RapidOCR JSONL worker for JCC Runtime")
    parser.add_argument("--config", default=None, help="RapidOCR config path")
    args = parser.parse_args()
    ocr = create_ocr(args.config)
    warmup_ms = warm_ocr(ocr)
    print(json.dumps({
        "schema": "jcc-rapidocr-worker-ready-v1",
        "ok": True,
        "warmup_ms": warmup_ms,
        "config_path": str(Path(args.config).resolve()) if args.config else None,
        "ready_means_model_hot": True,
    }), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            if request.get("command") == "shutdown" or request.get("type") == "shutdown":
                print(json.dumps({"ok": True, "shutdown": True}), flush=True)
                return
            response = handle_request(ocr, request)
        except Exception as exc:
            response = {
                "schema": "jcc-rapidocr-result-batch-v1",
                "ok": False,
                "id": request_id,
                "error": str(exc),
            }
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
