import { createHash } from "node:crypto";

export function windowsSafeArtifactToken(value, fallback = "artifact") {
  const raw = String(value || fallback);
  const safe = raw
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/[.\s]+$/g, "")
    .slice(0, 140) || fallback;
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 12);
  return `${safe}-${digest}`;
}
