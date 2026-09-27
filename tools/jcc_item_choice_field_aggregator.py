import argparse
import json
from pathlib import Path


DEFAULT_CATALOG = "data/runtime/jcc/mumu-catalog-overlay.json"
DEFAULT_ITEM_CHOICE_KIND = "basic_component_forge"
ITEM_CHOICE_KIND_LABELS = {
    "basic_component_forge": "基础装备锻造器",
    "completed_item_forge": "装备锻造器",
    "artifact_forge": "神器锻造器",
}


def parse_args():
    parser = argparse.ArgumentParser(description="Aggregate item-choice OCR into structured JCC item options.")
    parser.add_argument("--ocr-result", required=True)
    parser.add_argument("--phase", default="item_choice")
    parser.add_argument("--item-choice-kind", default=DEFAULT_ITEM_CHOICE_KIND, choices=sorted(ITEM_CHOICE_KIND_LABELS))
    parser.add_argument("--catalog", default=DEFAULT_CATALOG)
    parser.add_argument("--out", default=None)
    return parser.parse_args()


def read_json(path):
    with Path(path).open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path, payload):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def normalize_text(text):
    return "".join(str(text or "").split()).lower()


def block_rect(block):
    rect = block.get("rect") or block.get("bbox")
    if rect:
        return rect
    polygon = block.get("polygon") or []
    xs = [float(point[0]) for point in polygon if len(point) >= 2]
    ys = [float(point[1]) for point in polygon if len(point) >= 2]
    if not xs or not ys:
        return None
    return {"x": min(xs), "y": min(ys), "w": max(xs) - min(xs), "h": max(ys) - min(ys)}


def rect_center(rect):
    if not rect:
        return None
    return {
        "x": float(rect.get("x") or 0) + float(rect.get("w") or 0) / 2,
        "y": float(rect.get("y") or 0) + float(rect.get("h") or 0) / 2,
    }


def contains(roi, point):
    return (
        point
        and roi
        and point["x"] >= float(roi.get("x") or 0)
        and point["x"] <= float(roi.get("x") or 0) + float(roi.get("w") or 0)
        and point["y"] >= float(roi.get("y") or 0)
        and point["y"] <= float(roi.get("y") or 0) + float(roi.get("h") or 0)
    )


def confidence_from_blocks(blocks):
    values = [float(block.get("confidence") or 0) for block in blocks if block.get("confidence") is not None]
    if not values:
        return None
    return round(sum(values) / len(values), 4)


def item_entries(catalog):
    entries = []
    for entry in (catalog.get("items_by_id") or {}).values():
        name = str(entry.get("name") or "").strip()
        if name:
            entries.append(entry)
    return entries


def item_id_int(entry):
    try:
        return int(str(entry.get("id") or "").strip())
    except ValueError:
        return None


def item_matches_choice_kind(entry, item_choice_kind):
    item_id = item_id_int(entry)
    if item_choice_kind == "basic_component_forge":
        return item_id is not None and 1001 <= item_id <= 1010
    if item_choice_kind == "completed_item_forge":
        return item_id is not None and 2000 <= item_id < 3000
    if item_choice_kind == "artifact_forge":
        return item_id is not None and 6000 <= item_id < 7000
    return True


def match_item(name, catalog, item_choice_kind):
    normalized_name = normalize_text(name)
    if not normalized_name:
        return None
    for entry in item_entries(catalog):
        if not item_matches_choice_kind(entry, item_choice_kind):
            continue
        aliases = [
            entry.get("name"),
            entry.get("normalized_name"),
            *(entry.get("aliases") or []),
        ]
        if any(normalize_text(alias) == normalized_name for alias in aliases if alias):
            return {
                "kind": "item",
                "id": str(entry.get("id") or ""),
                "name": entry.get("name"),
                "icon_url": entry.get("icon_url"),
                "component_1": entry.get("component_1"),
                "component_2": entry.get("component_2"),
                "confidence": 0.96,
                "match_type": "exact_name",
            }
    return None


def result_image_size(result, blocks):
    roi = result.get("roi") or {}
    width = float(roi.get("w") or 0)
    height = float(roi.get("h") or 0)
    if width > 0 and height > 0:
        return width, height
    max_x = 1
    max_y = 1
    for block in blocks:
        rect = block_rect(block)
        if not rect:
            continue
        max_x = max(max_x, float(rect.get("x") or 0) + float(rect.get("w") or 0))
        max_y = max(max_y, float(rect.get("y") or 0) + float(rect.get("h") or 0))
    return max_x, max_y


def normalize_block_center(block, width, height):
    center = rect_center(block_rect(block))
    if not center:
        return None
    return {
        "x": center["x"] / width,
        "y": center["y"] / height,
    }


def iter_ocr_results(payload):
    for result in payload.get("results") or []:
        yield result


def aggregate_item_choice(payload, catalog, item_choice_kind):
    by_slot = {}
    for result in iter_ocr_results(payload):
        parts = result.get("evidence", {}).get("slot_parts") or []
        blocks = result.get("blocks") or []
        if not parts or not blocks:
            continue
        width, height = result_image_size(result, blocks)
        for block in blocks:
            text = str(block.get("text") or "").strip()
            if not text:
                continue
            point = normalize_block_center(block, width, height)
            matched = next((part for part in parts if contains(part.get("panel_relative_roi"), point)), None)
            if not matched:
                continue
            slot = int(matched.get("slot"))
            row = by_slot.setdefault(slot, {"name_parts": [], "name_evidence": []})
            row["name_parts"].append(text)
            row["name_evidence"].append({
                "text": text,
                "field": matched.get("field"),
                "slot_part": matched,
                "block": block,
                "crop_image": result.get("crop_image"),
            })

    choices = []
    unresolved_choices = []
    for slot in sorted(by_slot):
        row = by_slot[slot]
        name = "".join(row.get("name_parts") or []).strip()
        if not name:
            continue
        catalog_match = match_item(name, catalog, item_choice_kind)
        evidence_blocks = [entry.get("block") for entry in row.get("name_evidence") or [] if entry.get("block")]
        candidate = {
            "slot": slot,
            "text": catalog_match.get("name") if catalog_match else name,
            "name": catalog_match.get("name") if catalog_match else name,
            "raw_text": name,
            "id": catalog_match.get("id") if catalog_match else None,
            "confidence": catalog_match.get("confidence") if catalog_match else confidence_from_blocks(evidence_blocks),
            "source": "item_choice_roi_ocr",
            "item_choice_kind": item_choice_kind,
            "item_choice_label": ITEM_CHOICE_KIND_LABELS.get(item_choice_kind),
            "catalog_match": catalog_match,
            "evidence": {
                "name": row.get("name_evidence") or [],
            },
        }
        if not catalog_match:
            candidate["rejection_reason"] = "item_name_not_in_current_choice_catalog"
            unresolved_choices.append(candidate)
            continue
        choices.append(candidate)
    return choices, unresolved_choices


def aggregate(payload, phase, catalog, item_choice_kind):
    if phase != "item_choice":
        raise ValueError(f"Unsupported item choice phase: {phase}")
    choices, unresolved_choices = aggregate_item_choice(payload, catalog, item_choice_kind)
    expected_count_by_kind = {
        "basic_component_forge": 4,
        "completed_item_forge": 5,
        "artifact_forge": 4,
    }
    expected_count = expected_count_by_kind.get(item_choice_kind)
    stable_choice_window = (
        expected_count is not None
        and len(choices) == expected_count
        and not unresolved_choices
    )
    return {
        "schema": "jcc-item-choice-facts-v1",
        "ok": stable_choice_window,
        "phase": phase,
        "choice_kind": "item_choice_panel",
        "item_choice_kind": item_choice_kind,
        "item_choice_label": ITEM_CHOICE_KIND_LABELS.get(item_choice_kind),
        "choices": choices,
        "unresolved_choices": unresolved_choices,
        "expected_count": expected_count,
        "rejection_reason": None if stable_choice_window else "item_choice_requires_catalog_matched_expected_candidates",
        "items": {
            "choice_options": choices,
            "current_choice_set": {
                "source": "item_choice_roi_ocr",
                "item_choice_kind": item_choice_kind,
                "item_choice_label": ITEM_CHOICE_KIND_LABELS.get(item_choice_kind),
                "choices": choices,
            },
        },
        "field_status": {
            "items.choice_options": {
                "status": "observed" if stable_choice_window else "unresolved",
                "count": len(choices),
                "unresolved_count": len(unresolved_choices),
                "expected_count": expected_count,
                "source": "item_choice_roi_ocr",
                "item_choice_kind": item_choice_kind,
            },
        },
    }


def main():
    args = parse_args()
    payload = read_json(args.ocr_result)
    catalog = read_json(args.catalog)
    result = aggregate(payload, args.phase, catalog, args.item_choice_kind)
    if args.out:
        write_json(args.out, result)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
