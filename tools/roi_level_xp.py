import time
from pathlib import Path

from PIL import Image

from jcc_roi_common import (
    emit_crop_task_batch,
    parse_common_args,
    print_payload,
    read_json,
    normalized_roi_to_pixels,
    task,
    write_json,
)


def level_digit_roi(level_roi):
    return {
        "x": level_roi["x"],
        "y": level_roi["y"] + round(level_roi["h"] * 0.18),
        # Level 10 is the only two-digit level. Keep both digits inside the
        # calibrated level region without expanding into the XP label.
        "w": round(level_roi["w"] * 0.65),
        "h": round(level_roi["h"] * 0.48),
    }


def save_ocr_amplified_crop(image, out_dir, name, roi):
    x = roi["x"]
    y = roi["y"]
    w = roi["w"]
    h = roi["h"]
    crop = image.crop((x, y, x + w, y + h)).convert("L")
    crop = crop.resize((crop.width * 4, crop.height * 4), Image.Resampling.LANCZOS)
    crop = crop.point(lambda value: 255 if value > 145 else 0)
    path = Path(out_dir) / f"{name}.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    crop.save(path)
    return str(path)


def main():
    parser = parse_common_args("Emit crop tasks for visible JCC level and XP HUD text.")
    args = parser.parse_args()
    started = time.perf_counter()
    layout = read_json(args.layout)
    tasks = []
    with Image.open(args.frame) as image:
        image = image.convert("RGB")
        level_roi = normalized_roi_to_pixels(image, layout["regions"]["economy"]["level"])
        digit_roi = level_digit_roi(level_roi)
        level_crop = save_ocr_amplified_crop(image, args.out_dir, "economy-level-digit", digit_roi)
        tasks.append(task(
            "economy.level:bottom_hud",
            "economy.level",
            "numeric_text",
            level_crop,
            "tools/roi_level_xp.py",
            digit_roi,
            {
                "roi_reference": "regions.economy.level",
                "parent_roi": level_roi,
                "crop_policy": "level_digit_only_ocr_amplified",
                "ocr_profile": "single_line_numeric",
            },
        ))
        xp_roi = normalized_roi_to_pixels(image, layout["regions"]["economy"]["xp_progress"])
        xp_crop = save_ocr_amplified_crop(image, args.out_dir, "economy-xp-progress", xp_roi)
        tasks.append(task(
            "economy.xp:bottom_hud",
            "economy.xp",
            "xp_progress_text",
            xp_crop,
            "tools/roi_level_xp.py",
            xp_roi,
            {"roi_reference": "regions.economy.xp_progress"},
        ))
    payload = emit_crop_task_batch(args.frame, tasks, started)
    write_json(Path(args.out_dir) / "crop-tasks.json", payload)
    print_payload(payload)


if __name__ == "__main__":
    main()
