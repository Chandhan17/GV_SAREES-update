export const FALLBACK_IMAGE = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 1000"%3E%3Crect width="800" height="1000" fill="%23FFF8F7"/%3E%3Cpath d="M0 760c180-120 300-30 430-150s250-90 370-10v400H0z" fill="%2392716C" opacity=".14"/%3E%3Ccircle cx="220" cy="260" r="140" fill="%23D8ADA5" opacity=".2"/%3E%3C/svg%3E'

function getApiBaseUrl() {
  const configuredBase = import.meta.env?.VITE_API_BASE_URL?.trim()
  if (configuredBase) {
    return configuredBase.replace(/\/$/, '')
  }

  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin
  }

  return ''
}

function isTelegramProxyUrl(value) {
  return (
    typeof value === 'string' &&
    (value.startsWith('/api/image/') || /^https?:\/\/[^/]+\/api\/image\//i.test(value))
  )
}

function parseTelegramFileUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return { matched: false, filePath: '' }
  }

  let url
  try {
    url = new URL(value.trim())
  } catch {
    return {
      matched: /^https?:\/\/api\.telegram\.org\/file\/bot/i.test(value.trim()),
      filePath: '',
    }
  }

  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.hostname.toLowerCase() !== 'api.telegram.org' ||
    !/^\/file\/bot/i.test(url.pathname)
  ) {
    return { matched: false, filePath: '' }
  }

  const match = url.pathname.match(/^\/file\/bot[^/]+\/(.+)$/i)
  return {
    matched: true,
    filePath: match?.[1] || '',
  }
}

function extractProxyReference(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return ''
  }

  try {
    const url = value.startsWith('http://') || value.startsWith('https://') ? new URL(value) : new URL(value, 'http://local')
    if (!url.pathname.startsWith('/api/image/')) {
      return ''
    }

    return decodeURIComponent(url.pathname.replace(/^\/api\/image\//, ''))
  } catch {
    return ''
  }
}

export function getTelegramProxyUrl(fileId) {
  if (!fileId) return ''
  const baseUrl = getApiBaseUrl()
  const proxyPath = `/api/image/${encodeURIComponent(fileId)}`
  return baseUrl ? `${baseUrl}${proxyPath}` : proxyPath
}

function normalizeTelegramUrl(value) {
  if (isTelegramProxyUrl(value)) {
    const proxyReference = extractProxyReference(value)
    if (!proxyReference) {
      return { invalid: true }
    }

    const nestedTelegramUrl = parseTelegramFileUrl(proxyReference)
    if (nestedTelegramUrl.matched) {
      if (!nestedTelegramUrl.filePath) {
        return { invalid: true }
      }

      return {
        url: getTelegramProxyUrl(nestedTelegramUrl.filePath),
        file_id: null,
        file_path: nestedTelegramUrl.filePath,
      }
    }

    return {
      url: getTelegramProxyUrl(proxyReference),
      file_id: proxyReference.includes('/') ? null : proxyReference,
      file_path: proxyReference.includes('/') ? proxyReference : null,
    }
  }

  const directTelegramUrl = parseTelegramFileUrl(value)
  if (directTelegramUrl.matched) {
    if (!directTelegramUrl.filePath) {
      return { invalid: true }
    }

    return {
      url: getTelegramProxyUrl(directTelegramUrl.filePath),
      file_id: null,
      file_path: directTelegramUrl.filePath,
    }
  }

  return null
}

function safeMetadataValue(value) {
  if (typeof value === 'string' && parseTelegramFileUrl(value).matched) {
    return null
  }

  return value || null
}

function normalizeImageMetadata(item, fallback = {}) {
  const parsedFileId = parseTelegramFileUrl(item.file_id)
  const parsedFilePath = parseTelegramFileUrl(item.file_path)
  const fileId = parsedFileId.matched ? null : item.file_id || fallback.file_id || null
  const filePath = parsedFilePath.matched
    ? parsedFilePath.filePath || null
    : item.file_path || fallback.file_path || (parsedFileId.matched ? parsedFileId.filePath : null) || null

  return {
    public_id: safeMetadataValue(item.public_id),
    file_id: fileId,
    file_path: filePath,
    telegram_message_id: safeMetadataValue(item.telegram_message_id),
    telegram_chat_id: safeMetadataValue(item.telegram_chat_id),
  }
}

function normalizeImageFromMetadata(item) {
  const metadata = normalizeImageMetadata(item)
  const fileRef = metadata.file_id || metadata.file_path

  if (!fileRef) {
    return null
  }

  return {
    url: getTelegramProxyUrl(fileRef),
    ...metadata,
  }
}

export function normalizeImageItem(item) {
  if (!item) return null

  if (typeof item === 'string') {
    if (!item.trim()) return null

    const telegramUrl = normalizeTelegramUrl(item)
    if (telegramUrl?.invalid) return null
    if (telegramUrl) {
      return {
        ...telegramUrl,
        public_id: null,
        telegram_message_id: null,
        telegram_chat_id: null,
      }
    }

    return {
      url: item,
      public_id: null,
      telegram_message_id: null,
      telegram_chat_id: null,
    }
  }

  if (typeof item === 'object' && typeof item.url === 'string') {
    const telegramUrl = normalizeTelegramUrl(item.url)
    const metadata = normalizeImageMetadata(item, telegramUrl || {})

    if (telegramUrl?.invalid) {
      return normalizeImageFromMetadata(item)
    }
    if (telegramUrl) {
      return {
        ...telegramUrl,
        ...metadata,
      }
    }

    if (item.url.trim()) {
      return {
        url: item.url,
        ...metadata,
      }
    }

    return normalizeImageFromMetadata(item)
  }

  if (typeof item === 'object' && (item.file_id || item.file_path)) {
    const directTelegramUrl = parseTelegramFileUrl(item.file_id || item.file_path)
    if (directTelegramUrl.matched) {
      return directTelegramUrl.filePath
        ? {
            url: getTelegramProxyUrl(directTelegramUrl.filePath),
            ...normalizeImageMetadata(item, { file_path: directTelegramUrl.filePath }),
          }
        : null
    }

    return normalizeImageFromMetadata(item)
  }

  return null
}

export function normalizeImages(items = []) {
  return Array.isArray(items) ? items.map(normalizeImageItem).filter(Boolean) : []
}

export function getImageUrl(item) {
  if (!item) return ''
  if (typeof item === 'string') {
    const telegramUrl = normalizeTelegramUrl(item)
    if (telegramUrl?.invalid) return ''
    return telegramUrl?.url || item
  }

  if (typeof item === 'object') {
    const fileRef = item.file_id || item.file_path
    if (fileRef) {
      const telegramReference = normalizeTelegramUrl(fileRef)
      if (telegramReference?.invalid) return ''
      if (telegramReference) return telegramReference.url
      return getTelegramProxyUrl(fileRef)
    }

    if (typeof item.url === 'string') {
      const telegramUrl = normalizeTelegramUrl(item.url)
      if (telegramUrl?.invalid) return ''
      return telegramUrl?.url || item.url
    }
  }

  return ''
}

export function normalizeImageUrl(value) {
  if (value === null || typeof value === 'undefined' || value === '') {
    return value
  }

  return getImageUrl(value) || null
}

export function getImagePublicId(item) {
  if (!item || typeof item === 'string') return ''
  return typeof item.public_id === 'string' ? item.public_id : ''
}

export function getPrimaryImageUrl(images, fallback = '') {
  const first = Array.isArray(images) ? images[0] : null
  return getImageUrl(first) || fallback
}