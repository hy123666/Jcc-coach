import argparse
import json
import sys
import time
from pathlib import Path

from PIL import Image


DEFAULT_LAYOUT = "data/runtime/jcc/visual-roi-layout.json"
DEFAULT_OUT_DIR = ".jcc-runtime-data/runtime-evidence/roi-crop-tasks"


def parse_common_args(description):
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument("--frame", required=True)
    parser.add_argument("--out-dir", default=DEFAULT_OUT_DIR)
    parser.add_argument("--layout", default=DEFAULT_LAYOUT)
    parser.add_argument("--debug", action="store_true")
    return parser


def read_json(path):
    with Path(path).open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path, payload):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def clamp(value, low, high):
    return max(low, min(high, value))


def normalized_roi_to_pixels(image, roi):
    width, height = image.size
    x = round(float(roi["x"]) * width)
    y = round(float(roi["y"]) * height)
    w = round(float(roi["w"]) * width)
    h = round(float(roi["h"]) * height)
    x = clamp(x, 0, width - 1)
    y = clamp(y, 0, height - 1)
    w = clamp(w, 1, width - x)
    h = clamp(h, 1, height - y)
    return {"x": x, "y": y, "w": w, "h": h}


def crop_box(image, box):
    x = int(box["x"])
    y = int(box["y"])
    w = int(box["w"])
    h = int(box["h"])
    return image.crop((x, y, x + w, y + h))


def save_crop(image, out_dir, name, roi):
    out_path = Path(out_dir) / f"{name}.png"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    crop_box(image, roi).save(out_path)
    return str(out_path)


def emit_crop_task_batch(frame, tasks, started_at, artifacts=None):
    return {
        "ok": bool(tasks),
        "schema": "jcc-roi-crop-task-batch-v1",
        "frame": str(Path(frame)),
        "tasks": tasks,
        "timing_ms": {
            "total": round((time.perf_counter() - started_at) * 1000, 3),
        },
        "artifacts": artifacts or {},
    }


def task(task_id, field, kind, crop_image, source_script, roi, evidence=None):
    return {
        "task_id": task_id,
        "field": field,
        "kind": kind,
        "crop_image": crop_image,
        "source_script": source_script,
        "roi": roi,
        "evidence": evidence or {},
    }


def print_payload(payload):
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def fail(message, code=1):
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False, indent=2), file=sys.stderr)
    sys.exit(code)
