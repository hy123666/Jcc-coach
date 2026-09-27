import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw


def pixel_box(region, width, height):
    return (
        round(region["x"] * width),
        round(region["y"] * height),
        round((region["x"] + region["w"]) * width),
        round((region["y"] + region["h"]) * height),
    )


def main():
    frame = Path(sys.argv[1])
    out = Path(sys.argv[2])
    layout = json.loads(Path("data/runtime/jcc/visual-roi-layout.json").read_text(encoding="utf-8"))
    image = Image.open(frame).convert("RGB")
    width, height = image.size
    draw = ImageDraw.Draw(image)
    colors = ["red", "lime", "yellow"]
    for slot in layout["regions"]["augment_choice_text_slots"]:
        color = colors[slot["slot"]]
        for key, outline in (("card", color), ("name", "white"), ("desc", "cyan")):
            box = pixel_box(slot[key], width, height)
            draw.rectangle(box, outline=outline, width=4)
            draw.text((box[0] + 3, box[1] + 3), f"slot{slot['slot']} {key}", fill=outline)
    out.parent.mkdir(parents=True, exist_ok=True)
    image.save(out)
    print(out.resolve())


if __name__ == "__main__":
    main()
