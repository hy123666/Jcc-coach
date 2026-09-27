import math
import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageOps

from jcc_roi_common import (
    clamp,
    crop_box,
    emit_crop_task_batch,
    parse_common_args,
    print_payload,
    save_crop,
    task,
    write_json,
)


def luminance(pixel):
    r, g, b = pixel[:3]
    return 0.299 * r + 0.587 * g + 0.114 * b


def is_ring_pixel(pixel):
    r, g, b = pixel[:3]
    max_c = max(r, g, b)
    min_c = min(r, g, b)
    sat = max_c - min_c
    return (
        (r > 175 and g > 120 and b < 150)
        or (r > 175 and 45 < g < 160 and b < 135)
        or (sat > 75 and max_c > 145)
        or (max_c > 205 and sat > 35)
    )


def sample_pixel(pixels, width, height, x, y):
    return pixels[clamp(round(x), 0, width - 1), clamp(round(y), 0, height - 1)]


def circle_boundary_score(pixels, width, height, center_x, center_y, radius):
    if center_x - radius - 4 < 0 or center_x + radius + 4 >= width:
        return None
    if center_y - radius - 4 < 0 or center_y + radius + 4 >= height:
        return None
    edge_values = []
    ring_hits = 0
    strong_edges = 0
    samples = 32
    for index in range(samples):
        angle = 2 * math.pi * index / samples
        cos_a = math.cos(angle)
        sin_a = math.sin(angle)
        inner = sample_pixel(pixels, width, height, center_x + (radius - 3) * cos_a, center_y + (radius - 3) * sin_a)
        outer = sample_pixel(pixels, width, height, center_x + (radius + 3) * cos_a, center_y + (radius + 3) * sin_a)
        current = sample_pixel(pixels, width, height, center_x + radius * cos_a, center_y + radius * sin_a)
        value = abs(luminance(inner) - luminance(outer)) + (18 if is_ring_pixel(current) else 0)
        edge_values.append(value)
        if is_ring_pixel(current):
            ring_hits += 1
        if value >= 32:
            strong_edges += 1
    coverage = strong_edges / samples
    color_coverage = ring_hits / samples
    if coverage < 0.17 and color_coverage < 0.12:
        return None
    sorted_edges = sorted(edge_values)
    avg_edge = sum(edge_values) / samples
    p80 = sorted_edges[round(samples * 0.8)]
    score = avg_edge * 3.0 + p80 * 1.4 + coverage * 260 + color_coverage * 170 + radius * 5.5
    return {
        "score": score,
        "radius": radius,
        "diameter": radius * 2,
        "coverage": coverage,
        "color_coverage": color_coverage,
        "avg_edge": avg_edge,
        "p80_edge": p80,
    }


def edge_score_for_row(image, cy, cx):
    width, height = image.size
    pixels = image.load()
    best = None
    for candidate_cx in range(clamp(cx - 30, 0, width - 1), clamp(cx + 12, 0, width - 1) + 1, 6):
        for candidate_cy in range(clamp(cy - 10, 0, height - 1), clamp(cy + 10, 0, height - 1) + 1, 4):
            for radius in range(24, 47, 3):
                scored = circle_boundary_score(pixels, width, height, candidate_cx, candidate_cy, radius)
                if scored is None:
                    continue
                adjusted = scored["score"] - abs(candidate_cy - cy) * 4.0
                if best is None or adjusted > best["edge_strength"]:
                    best = {"edge_strength": adjusted, "circle_center": {"x": candidate_cx, "y": candidate_cy}, **scored}
    if best is None:
        return {"edge_strength": 0, "diameter": 0, "coverage": 0, "color_coverage": 0, "bbox": None}
    center = best["circle_center"]
    radius = best["radius"]
    return {
        "edge_strength": round(best["edge_strength"], 2),
        "diameter": round(best["diameter"], 2),
        "coverage": round(best["coverage"], 3),
        "color_coverage": round(best["color_coverage"], 3),
        "circle_center": center,
        "bbox": {"x": round(center["x"] - radius), "y": round(center["y"] - radius), "w": round(radius * 2), "h": round(radius * 2)},
    }


def candidate_rows(image):
    width, height = image.size
    top = round(height * 0.1187)
    step = round(height * 0.0758)
    cx = round(width * 0.97125)
    rows = []
    for index in range(8):
        cy = top + index * step
        if 0 <= cy < height:
            rows.append({"index": index, "cy": cy, "cx": cx, **edge_score_for_row(image, cy, cx)})
    return rows


def hp_number_roi_for_row(image, row):
    width, height = image.size
    x = round(width * 0.895)
    y = clamp(row["cy"] - round(height * 0.031), 0, height - 1)
    right_limit = row.get("bbox", {}).get("x") if row.get("bbox") else None
    if isinstance(right_limit, int):
        w = max(54, right_limit - x - 6)
    else:
        w = round(width * 0.055)
    return {"x": x, "y": y, "w": min(w, round(width * 0.07)), "h": round(height * 0.0615)}


def prepare_hp_crop(image):
    gray = ImageOps.grayscale(image)
    gray = ImageOps.autocontrast(gray, cutoff=1)
    gray = ImageEnhance.Contrast(gray).enhance(1.8)
    return gray.resize((gray.width * 4, gray.height * 4), Image.Resampling.LANCZOS)


def row_has_reliable_local_player_ring(row):
    return bool(
        row.get("circle_center")
        and row.get("bbox")
        and float(row.get("edge_strength") or 0) >= 700
        and 42 <= float(row.get("diameter") or 0) <= 72
        and float(row.get("coverage") or 0) >= 0.55
        and float(row.get("color_coverage") or 0) >= 0.12
    )


def row_has_standard_scoreboard_geometry(row, width):
    bbox = row.get("bbox") or {}
    return bool(
        isinstance(bbox, dict)
        and int(row.get("index") or -1) in range(8)
        and float(bbox.get("x") or 0) >= width * 0.94
        and 42 <= float(row.get("diameter") or 0) <= 72
    )


def draw_debug_sheet(image, rows, selected, out_file):
    width, _ = image.size
    row_w = 360
    row_h = 120
    sheet = Image.new("RGB", (row_w, row_h * len(rows)), "black")
    draw = ImageDraw.Draw(sheet)
    for i, row in enumerate(rows):
        y0 = max(0, row["cy"] - 44)
        crop = image.crop((max(0, width - 230), y0, width, min(image.height, y0 + 88)))
        crop = crop.resize((min(row_w - 10, crop.width * 2), min(row_h - 28, crop.height * 2)))
        sheet.paste(crop, (5, i * row_h + 26))
        mark = "SELECTED " if row["index"] == selected["index"] else ""
        draw.text((5, i * row_h + 5), f"{mark}#{row['index']} cy={row['cy']} d={row['diameter']} score={row['edge_strength']}", fill=(255, 255, 255))
    sheet.save(out_file)


def main():
    parser = parse_common_args("Emit a crop task for the local player's HP number from the right scoreboard.")
    args = parser.parse_args()
    started = time.perf_counter()
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    with Image.open(args.frame) as image:
        image = image.convert("RGB")
        rows = candidate_rows(image)
        ranked = sorted(rows, key=lambda row: (row["edge_strength"], row["coverage"], row["diameter"]), reverse=True)
        if not ranked:
            payload = emit_crop_task_batch(args.frame, [], started, {"rows": rows})
            write_json(out_dir / "crop-tasks.json", payload)
            print_payload(payload)
            return
        selected = ranked[0]
        standard_scoreboard = row_has_standard_scoreboard_geometry(selected, image.width)
        verified_local_row = row_has_reliable_local_player_ring(selected)
        if not standard_scoreboard or not verified_local_row:
            artifacts = {
                "detector": "local_scoreboard_avatar_ring",
                "status": "standard_player_list_or_local_row_not_reliable",
                "scoreboard_layout_status": "standard_player_list" if standard_scoreboard else "not_standard_player_list",
                "local_row_status": "verified_local_row" if verified_local_row else "local_player_row_not_reliable",
                "selected_row": selected.get("index"),
                "edge_strength": selected.get("edge_strength"),
                "diameter": selected.get("diameter"),
                "coverage": selected.get("coverage"),
                "color_coverage": selected.get("color_coverage"),
            }
            if args.debug:
                debug_sheet = out_dir / "local-hp-row-candidates.png"
                draw_debug_sheet(image, rows, selected, debug_sheet)
                artifacts["debug_sheet"] = str(debug_sheet)
            payload = emit_crop_task_batch(args.frame, [], started, artifacts)
            payload["rows"] = rows if args.debug else []
            write_json(out_dir / "crop-tasks.json", payload)
            print_payload(payload)
            return
        hp_roi = hp_number_roi_for_row(image, selected)
        raw_crop = crop_box(image, hp_roi)
        raw_crop_path = out_dir / "economy-hp-local-raw.png"
        raw_crop.save(raw_crop_path)
        prepared = prepare_hp_crop(raw_crop)
        crop_path = out_dir / "economy-hp-local.png"
        prepared.save(crop_path)
        artifacts = {
            "hp_number_raw_image": str(raw_crop_path),
        }
        if args.debug:
            debug_sheet = out_dir / "local-hp-row-candidates.png"
            draw_debug_sheet(image, rows, selected, debug_sheet)
            avatar_roi = selected.get("bbox")
            if avatar_roi:
                artifacts["avatar_image"] = save_crop(image, out_dir, "economy-hp-local-avatar", avatar_roi)
            artifacts["debug_sheet"] = str(debug_sheet)
    payload = emit_crop_task_batch(args.frame, [
        task(
            "economy.hp:local_scoreboard_detected_row",
            "economy.hp",
            "numeric_text",
            str(crop_path),
            "tools/roi_hp_local.py",
            hp_roi,
            {
                "detector": "local_scoreboard_avatar_ring",
                "scoreboard_layout_status": "standard_player_list",
                "local_row_status": "verified_local_row",
                "ocr_profile": "single_line_numeric",
                "selected_row": selected["index"],
                "circle_center": selected.get("circle_center"),
                "diameter": selected.get("diameter"),
                "coverage": selected.get("coverage"),
                "color_coverage": selected.get("color_coverage"),
                "edge_strength": selected.get("edge_strength"),
            },
        )
    ], started, artifacts)
    payload["rows"] = rows if args.debug else []
    write_json(out_dir / "crop-tasks.json", payload)
    print_payload(payload)


if __name__ == "__main__":
    main()
