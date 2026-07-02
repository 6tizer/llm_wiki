/** 64-bit FNV-1a over UTF-16 code units for stable local ids, not security. */
export function fnv1a64Hex(text: string, seed = 0xcbf29ce484222325n): string {
  let hash = seed
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, "0")
}
