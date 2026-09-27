import time
from pathlib import Path

from PIL import Image

from jcc_roi_common import (
    emit_crop_task_batch,
    parse_common_args,
    print_payload,
    read_json,
    normalized_roi_to_pixels,
    save_crop,
    task,
    write_json,
)


def main():
    parser = parse_common_args("Emit a crop task for the visible JCC gold HUD text.")
    args = parser.parse_args()
    started = time.perf_counter()
    layout = read_json(args.layout)
    with Image.open(args.frame) as image:
        image = image.convert("RGB")
        roi = normalized_roi_to_pixels(image, layout["regions"]["economy"]["gold"])
        crop_image = save_crop(image, args.out_dir, "economy-gold", roi)
    payload = emit_crop_task_batch(args.frame, [
        task(
            "economy.gold:bottom_hud",
            "economy.gold",
            "numeric_text",
            crop_image,
            "tools/roi_gold.py",
            roi,
            {"roi_reference": "regions.economy.gold"},
        )
    ], started)
    write_json(Path(args.out_dir) / "crop-tasks.json", payload)
    print_payload(payload)


if __name__ == "__main__":
    main()
