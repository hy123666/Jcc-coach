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
    parser = parse_common_args("Emit a crop task for the visible JCC stage round HUD text.")
    args = parser.parse_args()
    started = time.perf_counter()
    layout = read_json(args.layout)
    with Image.open(args.frame) as image:
        image = image.convert("RGB")
        roi = normalized_roi_to_pixels(image, layout["regions"]["phase"]["top_bar"])
        crop_image = save_crop(image, args.out_dir, "phase-stage-round", roi)
    payload = emit_crop_task_batch(args.frame, [
        task(
            "phase.stage_round:top_bar",
            "phase.stage_round",
            "stage_round_text",
            crop_image,
            "tools/roi_stage.py",
            roi,
            {"roi_reference": "regions.phase.top_bar"},
        )
    ], started)
    write_json(Path(args.out_dir) / "crop-tasks.json", payload)
    print_payload(payload)


if __name__ == "__main__":
    main()
