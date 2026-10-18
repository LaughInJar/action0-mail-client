/** Decodes base64url (RFC 4648 §5, padding optional) into bytes. */
export function decodeBase64Url(data: string): Uint8Array<ArrayBuffer> {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "");
  const padded = base64.padEnd(
    base64.length + ((4 - (base64.length % 4)) % 4),
    "=",
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Encodes bytes as standard base64 (for `data:` URLs). */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
