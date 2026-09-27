import argparse
import json
import re
import sys
from pathlib import Path


FIELD_SOURCES = {
    "phase.stage_round": "tools/roi_stage.py",
    "economy.gold": "tools/roi_gold.py",
    "economy.level": "tools/roi_level_xp.py",
    "economy.xp": "tools/roi_level_xp.py",
    "economy.hp": "tools/roi_hp_local.py",
}


def parse_args():
    parser = argparse.ArgumentParser(description="Aggregate OCR result batches into structured JCC self-state facts.")
    parser.add_argument("--ocr-result", required=True, help="Path to jcc-ocr-result-batch-v1 JSON.")
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
        return str(result["text"])
    return " ".join(str(block.get("text") or "") for block in result.get("blocks") or [])


def confidence(result):
    blocks = result.get("blocks") or []
    values = [float(block.get("confidence") or 0) for block in blocks if block.get("confidence") is not None]
    if not values:
        return None
    return round(sum(values) / len(values), 4)


def parse_int(text, min_value=0, max_value=999):
    candidates = [int(match) for match in re.findall(r"\d{1,3}", text or "")]
    for value in candidates:
        if min_value <= value <= max_value:
            return value
    return None


def block_left(block):
    rect = block.get("rect")
    if isinstance(rect, dict) and rect.get("x") is not None:
        try:
            return float(rect["x"])
        except (TypeError, ValueError):
            return None
    for key in ("x", "left"):
        if block.get(key) is not None:
            try:
                return float(block[key])
            except (TypeError, ValueError):
                return None
    return None


def block_right(block, left):
    rect = block.get("rect")
    if isinstance(rect, dict) and rect.get("w") is not None:
        try:
            return left + float(rect["w"])
        except (TypeError, ValueError):
            return None
    return None


def parse_hp(result, text):
    if not has_authoritative_hp_evidence(result):
        return None
    blocks = result.get("blocks") or []
    digit_blocks = []
    for index, block in enumerate(blocks):
        digits = "".join(re.findall(r"\d", str(block.get("text") or "")))
        if not digits:
            continue
        left = block_left(block)
        if left is None:
            continue
        rect = block.get("rect") if isinstance(block.get("rect"), dict) else {}
        try:
            area = max(0.0, float(rect.get("w") or 0) * float(rect.get("h") or 0))
        except (TypeError, ValueError):
            area = 0.0
        digit_blocks.append({
            "index": index,
            "left": left,
            "right": block_right(block, left),
            "digits": digits,
            "area": area,
        })

    # The local scoreboard crop can include the small row number beside the
    # much larger HP glyph. Prefer the dominant glyph instead of concatenating
    # both. This preserves a real `100 1` reading while rejecting the observed
    # false-zero case `00 7`.
    blocks_by_area = sorted(digit_blocks, key=lambda block: block["area"], reverse=True)
    if blocks_by_area:
        dominant = blocks_by_area[0]
        runner_up_area = blocks_by_area[1]["area"] if len(blocks_by_area) > 1 else 0
        overlaps_companion = any(
            companion is not dominant
            and companion["left"] < dominant["left"]
            and dominant["right"] is not None
            and companion["right"] is not None
            and companion["left"] < dominant["right"]
            and dominant["left"] < companion["right"]
            for companion in blocks_by_area[1:]
        )
        if (
            dominant["area"] > 0
            and overlaps_companion
            and (runner_up_area <= 0 or dominant["area"] >= runner_up_area * 2)
        ):
            digits = dominant["digits"]
            if len(digits) > 1 and digits.startswith("0"):
                return None
            value = int(digits)
            return value if 1 <= value <= 150 else None

    if len(digit_blocks) >= 2:
        sorted_blocks = sorted(digit_blocks, key=lambda block: (block["left"], block["index"]))
        for previous, current in zip(sorted_blocks, sorted_blocks[1:]):
            if previous["left"] == current["left"]:
                return None
            if previous["right"] is not None and current["left"] < previous["right"]:
                return None
        reconstructed = "".join(block["digits"] for block in sorted_blocks)
        if len(reconstructed) > 1 and reconstructed.startswith("0"):
            return None
        if not re.fullmatch(r"\d{1,3}", reconstructed):
            return None
        value = int(reconstructed)
        return value if 1 <= value <= 150 else None

    numeric_tokens = re.findall(r"\d+", text or "")
    if len(numeric_tokens) != 1:
        return None
    token = numeric_tokens[0]
    if len(token) > 1 and token.startswith("0"):
        return None
    value = int(token)
    return value if 1 <= value <= 150 else None


def has_authoritative_hp_evidence(result):
    evidence = result.get("evidence")
    if not isinstance(evidence, dict):
        return False
    if evidence.get("detector") != "local_scoreboard_avatar_ring":
        return False
    if evidence.get("scoreboard_layout_status") != "standard_player_list":
        return False
    if evidence.get("local_row_status") != "verified_local_row":
        return False
    try:
        selected_row = int(evidence.get("selected_row"))
        edge_strength = float(evidence.get("edge_strength") or 0)
        diameter = float(evidence.get("diameter") or 0)
        coverage = float(evidence.get("coverage") or 0)
        color_coverage = float(evidence.get("color_coverage") or 0)
    except (TypeError, ValueError):
        return False
    return bool(
        0 <= selected_row <= 7
        and edge_strength >= 700
        and 42 <= diameter <= 72
        and coverage >= 0.55
        and color_coverage >= 0.12
    )


def parse_stage(text):
    match = re.search(r"([1-9])\s*[-—一]\s*([1-9])", text or "")
    if not match:
        return None
    return f"{match.group(1)}-{match.group(2)}"


def parse_xp(text):
    normalized = (text or "").replace(" ", "")
    if "已满" in normalized or normalized.lower() in {"max", "full"}:
        return {"status": "max", "display": "已满"}
    match = re.search(r"(\d{1,2})\s*/\s*(\d{1,3})", text or "")
    if not match:
        return None
    value = int(match.group(1))
    to_next = int(match.group(2))
    if value < 0 or to_next <= 0 or value > 99 or to_next > 120:
        return None
    return {"value": value, "to_next": to_next, "display": f"{value}/{to_next}"}


def observed_status(result, source):
    return {
        "source": source,
        "status": "observed",
        "confidence": confidence(result),
        "raw_text": joined_text(result),
    }


def missing_status(result, source, reason=None):
    status = {
        "source": source,
        "status": "missing",
        "confidence": confidence(result),
        "raw_text": joined_text(result),
    }
    if reason:
        status["reason"] = reason
    return status


def aggregate(payload):
    results = payload.get("results") or []
    requested_field_diagnostics = payload.get("requested_field_diagnostics") or {}
    requested_fields = payload.get("requested_fields") or [
        result.get("field") for result in results if result.get("field") in FIELD_SOURCES
    ]
    facts = {
        "schema": "jcc-self-state-facts-v1",
        "ok": False,
        "phase": {"stage_round": None},
        "economy": {
            "hp": None,
            "gold": None,
            "level": None,
            "xp": None,
        },
        "field_status": {},
    }
    for result in results:
        field = result.get("field")
        source = result.get("source_script") or result.get("source") or "resident_ocr_worker"
        text = joined_text(result)
        parsed = None
        if field == "phase.stage_round":
            parsed = parse_stage(text)
            facts["phase"]["stage_round"] = parsed
        elif field == "economy.hp":
            # A visible in-game HP of 0 means the game is effectively over for
            # coaching purposes. In active matches it has repeatedly been an OCR
            # false positive, so keep 0 as missing instead of triggering
            # emergency tempo advice.
            parsed = parse_hp(result, text)
            facts["economy"]["hp"] = parsed
        elif field == "economy.gold":
            parsed = parse_int(text, 0, 999)
            facts["economy"]["gold"] = parsed
        elif field == "economy.level":
            parsed = parse_int(text, 1, 10)
            facts["economy"]["level"] = parsed
        elif field == "economy.xp":
            parsed = parse_xp(text)
            facts["economy"]["xp"] = parsed
        else:
            continue
        facts["field_status"][field] = observed_status(result, source) if parsed is not None else missing_status(result, source)
    for field in requested_fields:
        if field not in FIELD_SOURCES or field in facts["field_status"]:
            continue
        diagnostic = requested_field_diagnostics.get(field) or {}
        status = missing_status(
            {},
            diagnostic.get("source_script") or FIELD_SOURCES[field],
            diagnostic.get("roi_status") or "no_ocr_result_for_requested_field",
        )
        status["diagnostics"] = {
            key: diagnostic.get(key)
            for key in (
                "task_count",
                "scoreboard_layout_status",
                "local_row_status",
                "selected_row",
            )
            if diagnostic.get(key) is not None
        }
        facts["field_status"][field] = status
    if facts["economy"]["level"] == 10 and facts["economy"]["xp"] is None:
        facts["economy"]["xp"] = {"status": "max", "display": "已满"}
        facts["field_status"]["economy.xp"] = {
            "source": "tools/roi_level_xp.py:level_10_implies_max_xp",
            "status": "observed",
            "confidence": facts["field_status"].get("economy.level", {}).get("confidence"),
            "raw_text": facts["field_status"].get("economy.xp", {}).get("raw_text", ""),
        }
    facts["ok"] = bool(facts["phase"]["stage_round"] or any(value is not None for value in facts["economy"].values()))
    return facts


def main():
    args = parse_args()
    payload = read_json(args.ocr_result)
    result = aggregate(payload)
    if args.out:
        write_json(args.out, result)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
