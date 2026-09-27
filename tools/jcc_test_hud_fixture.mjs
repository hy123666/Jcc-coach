import { writeFile } from "node:fs/promises";

export async function writeSyntheticHudFrame(file, { width = 1600, height = 900 } = {}) {
  const pixels = Buffer.alloc(width * height * 3, 12);
  const centerX = Math.round(width * 0.97125);
  const centerY = Math.round(height * 0.1187) + Math.round(height * 0.0758);
  const radius = 30;
  for (let y = Math.max(0, centerY - radius); y <= Math.min(height - 1, centerY + radius); y += 1) {
    for (let x = Math.max(0, centerX - radius); x <= Math.min(width - 1, centerX + radius); x += 1) {
      if (((x - centerX) ** 2) + ((y - centerY) ** 2) > radius ** 2) continue;
      const offset = (y * width + x) * 3;
      pixels[offset] = 240;
      pixels[offset + 1] = 150;
      pixels[offset + 2] = 35;
    }
  }
  const header = Buffer.from(`P6\n${width} ${height}\n255\n`, "ascii");
  await writeFile(file, Buffer.concat([header, pixels]));
  return file;
}
