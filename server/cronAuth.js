import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'

export function cronSecretMatches(expected, provided) {
  if (typeof expected !== 'string' || expected.length < 32 || typeof provided !== 'string') return false
  const expectedBytes = Buffer.from(expected)
  const providedBytes = Buffer.from(provided)
  return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes)
}
