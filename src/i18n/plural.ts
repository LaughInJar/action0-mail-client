/** "1 message" / "2 messages": English and German both have just these two forms. */
export function plural(n: number, one: string, other: string): string {
  return n === 1 ? one : other;
}
