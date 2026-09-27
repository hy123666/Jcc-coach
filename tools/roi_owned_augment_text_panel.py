import time

from jcc_roi_common import emit_crop_task_batch, fail, normalized_roi_to_pixels, parse_common_args, print_payload, read_json, save_crop, task
from PIL import Image


SOURCE_SCRIPT = "tools/roi_owned_augment_text_panel.py"


def parse_args():
    return parse_common_args("Emit crop tasks for the JCC owned augment text panel.").parse_args()


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
    regions = layout.get("regions") or {}
    panel_roi = regions.get("owned_augment_text_panel")
    slots = regions.get("owned_augment_text_panel_slots") or []
    if not panel_roi:
        fail("Missing regions.owned_augment_text_panel")
    if len(slots) != 3:
        fail("regions.owned_augment_text_panel_slots must contain exactly three augment rows")

    image = Image.open(args.frame).convert("RGB")
    panel_pixels = normalized_roi_to_pixels(image, panel_roi)
    panel_path = save_crop(image, args.out_dir, "owned_augment_text_panel", panel_pixels)
    slot_parts = []
    for slot in slots:
        slot_id = int(slot.get("slot", len(slot_parts)))
        text_roi = slot.get("text")
        if not text_roi:
            fail(f"Missing text ROI for owned augment text panel slot {slot_id}")
        kind = slot.get("kind") or "augment"
        if kind != "augment":
            fail(f"Unsupported non-augment row in owned augment text panel: {kind}")
        choice_stage_round = slot.get("choice_stage_round")
        slot_parts.append({
            "slot": slot_id,
            "part": "text",
            "kind": kind,
            "choice_stage_round": choice_stage_round,
            "field": f"augments.selected_augments.{slot_id}.text",
            "normalized_roi": text_roi,
            "panel_relative_roi": relative_roi(text_roi, panel_roi),
        })

    tasks = [task(
        task_id="owned_augment_text_panel.panel",
        field="match_context.choice_confirmations.owned_augment_text_panel",
        kind="owned_augment_text_panel",
        crop_image=panel_path,
        source_script=SOURCE_SCRIPT,
        roi=panel_pixels,
        evidence={
            "normalized_roi": panel_roi,
            "slot_parts": slot_parts,
        },
    )]
    print_payload(emit_crop_task_batch(args.frame, tasks, started_at, {}))


if __name__ == "__main__":
    main()
