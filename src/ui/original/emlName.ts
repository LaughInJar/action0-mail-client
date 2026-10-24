/** A file name for the downloaded original: its subject, made safe. */
export function emlName(subject: string | undefined): string {
  const safe = (subject ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100)
    .trim();
  return `${safe || "message"}.eml`;
}
