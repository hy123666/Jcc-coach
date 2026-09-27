import time

from jcc_roi_common import crop_box, emit_crop_task_batch, fail, normalized_roi_to_pixels, parse_common_args, print_payload, read_json, save_crop, task
from PIL import Image


SOURCE_SCRIPT = "tools/roi_augment_choice.py"


def parse_args():
    parser = parse_common_args("Emit crop tasks for visible JCC augment choices.")
    parser.add_argument("--phase", default="augment_choice")
    return parser.parse_args()


def augment_slots(layout, phase):
    regions = layout.get("regions") or {}
    if phase == "augment_choice":
        slots = regions.get("augment_choice_text_slots") or []
        output = []
        for slot in slots:
            slot_id = int(slot.get("slot", len(output)))
            if slot.get("name"):
                output.append((slot_id, "name", "augment_choice", slot["name"]))
            if slot.get("desc"):
                output.append((slot_id, "desc", "augment_choice", slot["desc"]))
        return output
    fail(f"Unsupported augment choice phase: {phase}")


def augment_panel(layout, phase):
    regions = layout.get("regions") or {}
    phase_regions = regions.get("phase") or {}
    if phase == "augment_choice":
        return phase_regions.get("augment_choice_panel")
    fail(f"Unsupported augment choice phase: {phase}")


def relative_roi(child, parent):
    return {
        "x": (float(child["x"]) - float(parent["x"])) / float(parent["w"]),
        "y": (float(child["y"]) - float(parent["y"])) / float(parent["h"]),
        "w": float(child["w"]) / float(parent["w"]),
        "h": float(child["h"]) / float(parent["h"]),
    }


def main():
    args = parse_args()
    started_at = time.perf_counter()
    layout = read_json(args.layout)
    image = Image.open(args.frame).convert("RGB")
    tasks = []
    artifacts = {}
    panel_roi = augment_panel(layout, args.phase)
    if not panel_roi:
        fail(f"No augment choice ROI for phase: {args.phase}")
    panel_pixels = normalized_roi_to_pixels(image, panel_roi)
    panel_path = save_crop(image, args.out_dir, f"{args.phase}_panel", panel_pixels)
    slot_parts = []
    for slot_id, part, kind, roi in augment_slots(layout, args.phase):
        slot_parts.append({
            "slot": slot_id,
            "part": part,
            "kind": kind,
            "field": f"choices.{args.phase}.{slot_id}.{part}",
            "normalized_roi": roi,
            "panel_relative_roi": relative_roi(roi, panel_roi),
        })
    tasks.append(task(
        task_id=f"{args.phase}.panel",
        field=f"choices.{args.phase}.panel",
        kind=args.phase,
        crop_image=panel_path,
        source_script=SOURCE_SCRIPT,
        roi=panel_pixels,
        evidence={
            "phase": args.phase,
            "normalized_roi": panel_roi,
            "slot_parts": slot_parts,
        },
    ))
    payload = emit_crop_task_batch(args.frame, tasks, started_at, artifacts)
    print_payload(payload)


if __name__ == "__main__":
    main()
