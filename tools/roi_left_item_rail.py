import time
from pathlib import Path

from PIL import Image

from jcc_roi_common import (
    emit_crop_task_batch,
    fail,
    normalized_roi_to_pixels,
    parse_common_args,
    print_payload,
    read_json,
    save_crop,
    task,
)


SOURCE_SCRIPT = "tools/roi_left_item_rail.py"


def parse_args():
    parser = parse_common_args("Emit crop tasks for the fixed left item rail slots.")
    return parser.parse_args()


def slot_column(slot):
    return 0 if int(slot) < 10 else 1


def slot_row(slot):
    return int(slot) % 10


def main():
    args = parse_args()
    started_at = time.perf_counter()
    frame_path = Path(args.frame)
    if not frame_path.exists():
        fail(f"frame image not found: {frame_path}")
    layout = read_json(args.layout)
    slots = layout.get("regions", {}).get("item_bench_slots") or []
    if not slots:
        fail("layout missing regions.item_bench_slots")

    image = Image.open(frame_path).convert("RGBA")
    tasks = []
    for region in slots:
        slot = int(region.get("slot", len(tasks)))
        roi = normalized_roi_to_pixels(image, region)
        crop_image = save_crop(image, args.out_dir, f"left_item_rail_slot_{slot:02d}", roi)
        tasks.append(task(
            task_id=f"left_item_rail_slot_{slot}",
            field=f"items.item_bench.{slot}",
            kind="item_icon",
            crop_image=crop_image,
            source_script=SOURCE_SCRIPT,
            roi=roi,
            evidence={
                "source": "left_item_rail_roi_crop",
                "slot": slot,
                "column": slot_column(slot),
                "row": slot_row(slot),
                "layout_region": region,
                "scope": "items.item_bench_only",
            },
        ))

    print_payload(emit_crop_task_batch(
        str(frame_path),
        tasks,
        started_at,
        artifacts={
            "layout": args.layout,
            "slot_count": len(tasks),
            "recognition_layer": "item_icon_matcher",
        },
    ))


if __name__ == "__main__":
    main()
