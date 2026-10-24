/** A base64 SHA-1 as Google Cloud shows fingerprints: hex pairs with colons. */
export function sha1Hex(base64: string): string {
  try {
    return Array.from(atob(base64), (char) =>
      char.charCodeAt(0).toString(16).padStart(2, "0").toUpperCase(),
    ).join(":");
  } catch {
    return base64;
  }
}
