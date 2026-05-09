/**
 * Multipart-body splitter. Splits a body string on a boundary marker and
 * returns the inner parts (the closing `--<boundary>--` is dropped).
 */

export function splitOnBoundary(body: string, boundary: string): string[] {
  const marker = `--${boundary}`;

  if (!body.includes(marker)) return [];

  // Drop everything before the first boundary.
  const idx = body.indexOf(marker);
  const tail = body.slice(idx + marker.length);

  // Split on every boundary; the segment after the closing marker is dropped.
  const segments = tail.split(marker);

  const parts: string[] = [];
  for (const seg of segments) {
    // Skip the closing marker's residue (starts with "--").
    if (seg.startsWith('--')) continue;
    // Trim a single leading newline only — preserve internal whitespace.
    const stripped = seg.startsWith('\n') ? seg.slice(1) : seg;
    // Drop trailing newline (boundaries are line-anchored).
    const trimmed = stripped.endsWith('\n') ? stripped.slice(0, -1) : stripped;
    if (trimmed.length === 0 && seg.length === 0) continue;
    parts.push(trimmed);
  }
  return parts;
}
