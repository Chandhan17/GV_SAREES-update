export async function processExpiryPages(fetchPage, expire, { pageSize = 50, maxPages = 10 } = {}) {
  let cursor = null
  let processed = 0
  let released = 0
  let failed = 0

  for (let page = 0; page < maxPages; page += 1) {
    const docs = await fetchPage({ cursor, limit: pageSize })
    if (!docs.length) break
    for (const document of docs) {
      processed += 1
      try {
        if (await expire(document)) released += 1
      } catch {
        failed += 1
      }
    }
    cursor = docs[docs.length - 1]
    if (docs.length < pageSize) break
  }

  return { processed, released, failed, hasMore: processed === pageSize * maxPages }
}
