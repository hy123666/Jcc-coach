import argparse
import json
from pathlib import Path


def active_core_catalog():
    knowledge_root = Path("data/game-knowledge/jcc")
    active_profile = read_json(knowledge_root / "active-profile.json")
    catalog_path = active_profile.get("decision_input_catalog_path")
    if not catalog_path:
        raise ValueError("active Core Profile does not declare decision_input_catalog_path")
    return str(knowledge_root / catalog_path)


def parse_args():
    parser = argparse.ArgumentParser(description="Aggregate augment-choice OCR into structured JCC choices.")
    parser.add_argument("--ocr-result", required=True)
    parser.add_argument("--phase", default="augment_choice")
    parser.add_argument("--catalog", default=None)
    parser.add_argument("--out", default=None)
    return parser.parse_args()


def read_json(path):
    with Path(path).open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path, payload):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def joined_text(result):
    if result.get("text"):
        return str(result["text"]).strip()
    return "".join(str(block.get("text") or "").strip() for block in result.get("blocks") or [])


def confidence(result):
    blocks = result.get("blocks") or []
    values = [float(block.get("confidence") or 0) for block in blocks if block.get("confidence") is not None]
    if not values:
        return None
    return round(sum(values) / len(values), 4)


def normalize_text(text):
    return "".join(str(text or "").split()).lower()


def augment_catalog_entries(catalog):
    if catalog.get("schema") == "jcc-decision-input-catalog-v1":
        source_entries = catalog.get("entities") or []
    else:
        source_entries = (catalog.get("augments_by_id") or {}).values()
    entries = []
    for entry in source_entries:
        if entry.get("kind") and entry.get("kind") != "augment":
            continue
        name = str(entry.get("name") or "").strip()
        if not name:
            continue
        entries.append(entry)
    return entries


def match_augment(name, catalog):
    normalized_name = normalize_text(name)
    if not normalized_name:
        return None
    for entry in augment_catalog_entries(catalog):
        if normalize_text(entry.get("name")) == normalized_name:
            return {
                "kind": "augment",
                "id": str(entry.get("id") or ""),
                "name": entry.get("name"),
                "address": entry.get("address"),
                "tier": entry.get("tier") or entry.get("tier_color"),
                "icon_url": entry.get("icon_url"),
                "confidence": 0.96,
                "match_type": "exact_name",
            }
    return None


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


def image_size_from_blocks(blocks):
    max_x = 1
    max_y = 1
    for block in blocks:
        rect = block_rect(block)
        if not rect:
            continue
        max_x = max(max_x, float(rect.get("x") or 0) + float(rect.get("w") or 0))
        max_y = max(max_y, float(rect.get("y") or 0) + float(rect.get("h") or 0))
    return max_x, max_y


def result_image_size(result, blocks):
    roi = result.get("roi") or {}
    width = float(roi.get("w") or 0)
    height = float(roi.get("h") or 0)
    if width > 0 and height > 0:
        return width, height
    return image_size_from_blocks(blocks)


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
    for crop in payload.get("crops") or []:
        ocr = crop.get("ocr") or {}
        result = {
            **crop,
            "blocks": ocr.get("blocks") or [],
            "text": ocr.get("text"),
            "evidence": {
                **(crop.get("evidence") or {}),
                "slot_parts": crop.get("slot_parts") or (crop.get("evidence") or {}).get("slot_parts") or [],
            },
            "roi": crop.get("roi") or {"w": crop.get("width"), "h": crop.get("height")},
        }
        yield result


def aggregate_augment_choice(payload, catalog):
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
            matched = None
            for part in parts:
                if contains(part.get("panel_relative_roi"), point):
                    matched = part
                    break
            if not matched:
                continue
            slot = int(matched.get("slot"))
            part_name = matched.get("part")
            by_slot.setdefault(slot, {"description_lines": [], "description_evidence": []})
            block_result = {
                "id": result.get("id"),
                "ok": result.get("ok"),
                "text": text,
                "blocks": [block],
                "field": matched.get("field"),
                "slot_part": matched,
                "roi": result.get("roi"),
            }
            if part_name == "name":
                previous = by_slot[slot].get("name")
                by_slot[slot]["name"] = f"{previous}{text}" if previous else text
                by_slot[slot]["name_confidence"] = confidence(block_result)
                by_slot[slot].setdefault("name_evidence", []).append(block_result)
            elif part_name == "desc":
                by_slot[slot]["description_lines"].append(text)
                by_slot[slot]["description_evidence"].append(block_result)

    choices = []
    unresolved_choices = []
    for slot in sorted(by_slot):
        row = by_slot[slot]
        name = str(row.get("name") or "").strip()
        if not name:
            continue
        catalog_match = match_augment(name, catalog)
        candidate = {
            "slot": slot,
            "text": catalog_match.get("name") if catalog_match else name,
            "name": catalog_match.get("name") if catalog_match else name,
            "description_lines": row.get("description_lines") or [],
            "id": catalog_match.get("id") if catalog_match else None,
            "confidence": catalog_match.get("confidence") if catalog_match else row.get("name_confidence"),
            "source": "resident_ocr_worker",
            "catalog_match": catalog_match,
            "evidence": {
                "name": row.get("name_evidence"),
                "description": row.get("description_evidence") or [],
            },
        }
        if not catalog_match:
            candidate["rejection_reason"] = "augment_name_not_in_current_catalog"
            unresolved_choices.append(candidate)
            continue
        choices.append(candidate)
    return choices, unresolved_choices


def aggregate(payload, phase, catalog):
    if phase != "augment_choice":
        raise ValueError(f"Unsupported choice phase: {phase}")
    choices, unresolved_choices = aggregate_augment_choice(payload, catalog)
    stable_choice_window = len(choices) == 3 and not unresolved_choices
    return {
        "schema": "jcc-augment-choice-facts-v1",
        "ok": stable_choice_window,
        "phase": phase,
        "choice_kind": "augment_choice",
        "choices": choices,
        "unresolved_choices": unresolved_choices,
        "rejection_reason": None if stable_choice_window else "augment_choice_requires_three_catalog_matched_candidates",
        "augments": {
            "choice_candidates": choices,
            "current_choice_set": {
                "source": "augment_choice_roi_ocr",
                "choices": choices,
            },
        },
        "field_status": {
            "choices": {
                "status": "observed" if stable_choice_window else "unresolved",
                "count": len(choices),
                "unresolved_count": len(unresolved_choices),
                "expected_count": 3,
                "source": "augment_choice_roi_ocr",
            },
        },
    }


def main():
    args = parse_args()
    payload = read_json(args.ocr_result)
    catalog = read_json(args.catalog or active_core_catalog())
    result = aggregate(payload, args.phase, catalog)
    if args.out:
        write_json(args.out, result)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
