import time

from jcc_roi_common import emit_crop_task_batch, fail, normalized_roi_to_pixels, parse_common_args, print_payload, read_json, save_crop, task
from PIL import Image


SOURCE_SCRIPT = "tools/roi_item_choice.py"
ITEM_CHOICE_KINDS = {
    "basic_component_forge": {
        "label": "基础装备锻造器",
        "option_count": 4,
        "layout_key": "basic_component_forge_name_row",
        "fallback_layout_key": None,
    },
    "completed_item_forge": {
        "label": "装备锻造器",
        "option_count": 5,
        "layout_key": "completed_item_forge_name_row",
        "fallback_layout_key": None,
    },
    "artifact_forge": {
        "label": "神器锻造器",
        "option_count": 4,
        "layout_key": "artifact_forge_name_row",
        "fallback_layout_key": None,
    },
}
DEFAULT_ITEM_CHOICE_KIND = "basic_component_forge"


def parse_args():
    parser = parse_common_args("Emit crop tasks for visible JCC item forge choice names.")
    parser.add_argument("--phase", default="item_choice")
    parser.add_argument("--item-choice-kind", default=DEFAULT_ITEM_CHOICE_KIND, choices=sorted(ITEM_CHOICE_KINDS))
    return parser.parse_args()


def item_choice_row(layout, phase, item_choice_kind):
    if phase != "item_choice":
        fail(f"Unsupported item choice phase: {phase}")
    config = ITEM_CHOICE_KINDS.get(item_choice_kind)
    if not config:
        fail(f"Unsupported item choice kind: {item_choice_kind}")
    regions = layout.get("regions") or {}
    row = regions.get(config["layout_key"])
    if row:
        return row
    fail(f"No item choice ROI is configured for {item_choice_kind}.")


def slot_parts(row_roi, item_choice_kind):
    config = ITEM_CHOICE_KINDS[item_choice_kind]
    option_count = int(config["option_count"])
    parts = []
    slot_width = 1.0 / option_count
    for slot in range(option_count):
        parts.append({
            "slot": slot,
            "part": "name",
            "kind": item_choice_kind,
            "field": f"items.choice_options.{slot}.name",
            "item_choice_kind": item_choice_kind,
            "normalized_roi": {
                "x": float(row_roi["x"]) + float(row_roi["w"]) * slot_width * slot,
                "y": float(row_roi["y"]),
                "w": float(row_roi["w"]) * slot_width,
                "h": float(row_roi["h"]),
            },
            "panel_relative_roi": {
                "x": slot_width * slot,
                "y": 0.0,
                "w": slot_width,
                "h": 1.0,
            },
        })
    return parts


def main():
    args = parse_args()
    started_at = time.perf_counter()
    layout = read_json(args.layout)
    image = Image.open(args.frame).convert("RGB")
    item_choice_kind = args.item_choice_kind
    config = ITEM_CHOICE_KINDS[item_choice_kind]
    row_roi = item_choice_row(layout, args.phase, item_choice_kind)
    row_pixels = normalized_roi_to_pixels(image, row_roi)
    row_path = save_crop(image, args.out_dir, f"{args.phase}_{item_choice_kind}_name_row", row_pixels)
    tasks = [
        task(
            task_id=f"{args.phase}.{item_choice_kind}.name_row",
            field="items.choice_options.name_row",
            kind=item_choice_kind,
            crop_image=row_path,
            source_script=SOURCE_SCRIPT,
            roi=row_pixels,
            evidence={
                "phase": args.phase,
                "choice_kind": "item_choice_panel",
                "item_choice_kind": item_choice_kind,
                "item_choice_label": config["label"],
                "option_count": int(config["option_count"]),
                "normalized_roi": row_roi,
                "slot_parts": slot_parts(row_roi, item_choice_kind),
            },
        )
    ]
    payload = emit_crop_task_batch(args.frame, tasks, started_at, {})
    print_payload(payload)


if __name__ == "__main__":
    main()
