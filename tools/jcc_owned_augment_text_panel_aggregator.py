import argparse
import json
from pathlib import Path


DEFAULT_CATALOG = "data/runtime/jcc/mumu-catalog-overlay.json"
SOURCE = "user_triggered_owned_augment_text_panel_ocr"


def parse_args():
    parser = argparse.ArgumentParser(description="Aggregate owned augment text-panel OCR into match choice confirmations.")
    parser.add_argument("--ocr-result", required=True)
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


def augment_catalog_entries(catalog):
    entries = []
    for entry in (catalog.get("augments_by_id") or {}).values():
        name = str(entry.get("name") or "").strip()
        if name:
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
                "tier": entry.get("tier"),
                "icon_url": entry.get("icon_url"),
                "confidence": 0.96,
                "match_type": "exact_name",
            }
    return None


def confidence_for_blocks(blocks):
    values = [float(block.get("confidence") or 0) for block in blocks if block.get("confidence") is not None]
    if not values:
        return None
    return round(sum(values) / len(values), 4)


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


def contains(roi, point):
    return (
        point
        and roi
        and point["x"] >= float(roi.get("x") or 0)
        and point["x"] <= float(roi.get("x") or 0) + float(roi.get("w") or 0)
        and point["y"] >= float(roi.get("y") or 0)
        and point["y"] <= float(roi.get("y") or 0) + float(roi.get("h") or 0)
    )


def iter_ocr_results(payload):
    for result in payload.get("results") or []:
        yield result
    for crop in payload.get("crops") or []:
        ocr = crop.get("ocr") or {}
        yield {
            **crop,
            "blocks": ocr.get("blocks") or [],
            "text": ocr.get("text"),
            "evidence": {
                **(crop.get("evidence") or {}),
                "slot_parts": crop.get("slot_parts") or (crop.get("evidence") or {}).get("slot_parts") or [],
            },
            "roi": crop.get("roi") or {"w": crop.get("width"), "h": crop.get("height")},
        }


def aggregate_slots(payload):
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
            by_slot.setdefault(slot, {
                "slot": slot,
                "kind": matched.get("kind"),
                "choice_stage_round": matched.get("choice_stage_round"),
                "blocks": [],
                "lines": [],
                "evidence": [],
            })
            by_slot[slot]["lines"].append(text)
            by_slot[slot]["blocks"].append(block)
            by_slot[slot]["evidence"].append({
                "id": result.get("id") or result.get("task_id"),
                "field": matched.get("field"),
                "slot_part": matched,
                "text": text,
                "block": block,
            })
    return by_slot


def row_text(row):
    return "".join(str(line or "").strip() for line in row.get("lines") or []).strip()


def aggregate(payload, catalog):
    by_slot = aggregate_slots(payload)
    selected_augments = []
    confirmations = []
    field_status = {}

    for slot in sorted(by_slot):
        row = by_slot[slot]
        text = row_text(row)
        if not text:
            continue
        confidence = confidence_for_blocks(row.get("blocks") or [])
        if row.get("kind") == "augment":
            catalog_match = match_augment(text, catalog)
            choice = {
                "slot": slot,
                "slot_index": slot,
                "choice_stage_round": row.get("choice_stage_round"),
                "name": catalog_match.get("name") if catalog_match else text,
                "text": text,
                "entity_id": catalog_match.get("id") if catalog_match else None,
                "id": catalog_match.get("id") if catalog_match else None,
                "source": SOURCE,
                "confidence": catalog_match.get("confidence") if catalog_match else confidence,
                "catalog_match": catalog_match,
                "evidence": row.get("evidence") or [],
            }
            selected_augments.append(choice)
            confirmations.append({
                "type": "owned_augment_text_panel_confirmed",
                "kind": "augment",
                "choice_kind": "augment_choice",
                "choice_stage_round": choice["choice_stage_round"],
                "source": SOURCE,
                "confidence": choice["confidence"],
                "choice": {
                    "entity_id": choice["entity_id"],
                    "id": choice["id"],
                    "name": choice["name"],
                    "text": choice["text"],
                    "slot_index": slot,
                    "choice_stage_round": choice["choice_stage_round"],
                    "source": SOURCE,
                    "confidence": choice["confidence"],
                },
            })
    field_status["augments.selected_augments"] = {
        "status": "observed" if selected_augments else "missing",
        "count": len(selected_augments),
        "source": SOURCE,
    }
    return {
        "schema": "jcc-owned-augment-text-panel-facts-v1",
        "ok": bool(selected_augments),
        "source": SOURCE,
        "facts": {
            "selected_augments": selected_augments,
        },
        "choice_confirmations": confirmations,
        "match_context": {
            "choice_confirmations": confirmations,
        },
        "field_status": field_status,
    }


def main():
    args = parse_args()
    payload = read_json(args.ocr_result)
    catalog = read_json(args.catalog)
    result = aggregate(payload, catalog)
    if args.out:
        write_json(args.out, result)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
