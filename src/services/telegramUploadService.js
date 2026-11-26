import { getIdToken } from './authService'

const uploadEndpoint = import.meta.env.VITE_IMAGE_UPLOAD_ENDPOINT || '/api/upload-image'
const apiBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim()?.replace(/\/$/, '') || (typeof window !== 'undefined' ? window.location.origin : '')
const MAX_UPLOAD_IMAGE_BYTES = 4 * 1024 * 1024
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const imageUploadCache = new WeakMap()
const COMPRESSION_ATTEMPTS = [
  { maxDimension: 1600, quality: 0.86 },
  { maxDimension: 1400, quality: 0.8 },
  { maxDimension: 1200, quality: 0.74 },
  { maxDimension: 1000, quality: 0.68 },
]

function buildProxyUrl(fileRef) {
  if (!fileRef) return ''
  const proxyPath = `/api/image/${encodeURIComponent(fileRef)}`
  return apiBaseUrl ? `${apiBaseUrl}${proxyPath}` : proxyPath
}

function buildFormData(file, filename) {
  const formData = new FormData()
  formData.append('image', file, filename)
  return formData
}

function blobToWebp(canvas, quality) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(resolve, 'image/webp', quality)
    } catch (error) {
      reject(error)
    }
  })
}

function getCompressedFilename(filename, type) {
  const basename = String(filename || 'product-image').replace(/\.[^.]+$/, '') || 'product-image'
  const extension = type === 'image/jpeg' ? 'jpg' : type.split('/')[1] || 'webp'
  return `${basename}.${extension}`
}

export async function prepareImageForUpload(file) {
  if (!file) {
    throw new Error('No image file was provided.')
  }

  const type = String(file.type || '').toLowerCase()
  if (!ALLOWED_IMAGE_TYPES.has(type)) {
    throw new Error('Only JPEG, PNG or WEBP images are allowed.')
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    throw new Error('Selected image is empty.')
  }

  if (file.size <= MAX_UPLOAD_IMAGE_BYTES) {
    return { file, filename: file.name || 'product-image' }
  }

  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
    throw new Error('Image is too large to upload and cannot be compressed in this browser.')
  }

  let bitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error('Unable to read this image for compression.')
  }

  try {
    if (!bitmap.width || !bitmap.height) {
      throw new Error('Unable to read this image for compression.')
    }

    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context || typeof canvas.toBlob !== 'function') {
      throw new Error('Image compression is not supported in this browser.')
    }

    for (const attempt of COMPRESSION_ATTEMPTS) {
      const scale = Math.min(1, attempt.maxDimension / Math.max(bitmap.width, bitmap.height))
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)

      const compressed = await blobToWebp(canvas, attempt.quality)
      if (!compressed) {
        throw new Error('Image compression failed. Please choose another image.')
      }
      if (compressed.size <= MAX_UPLOAD_IMAGE_BYTES) {
        const filename = getCompressedFilename(file.name, compressed.type || 'image/webp')
        const compressedFile = new File([compressed], filename, {
          type: compressed.type || 'image/webp',
          lastModified: file.lastModified,
        })
        return {
          file: compressedFile,
          filename,
        }
      }
    }
  } finally {
    bitmap.close?.()
  }

  throw new Error('Image is too large to upload after compression. Please choose a smaller image.')
}

async function performImageUpload(file) {
  const prepared = await prepareImageForUpload(file)

  let responseBody
  try {
    const token = await getIdToken()
    const formData = buildFormData(prepared.file, prepared.filename)
    if (import.meta.env.DEV) {
      const entries = Array.from(formData.entries())
      console.info('[image-upload] FormData prepared', {
        isFormData: formData instanceof FormData,
        fieldNames: entries.map(([name]) => name),
        imageFieldCount: entries.filter(([name]) => name === 'image').length,
        filename: prepared.filename,
        fileSize: prepared.file.size,
        mimeType: prepared.file.type,
        contentTypeHeaderSet: false,
      })
    }

    const response = await fetch(uploadEndpoint, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    })
    responseBody = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw Object.assign(
        new Error(responseBody?.error || responseBody?.message || `Image upload failed (HTTP ${response.status}).`),
        { status: response.status },
      )
    }
  } catch (error) {
    if (error?.status === 413) {
      throw new Error(error.message || 'Image upload exceeds the server request limit. Choose a smaller image.')
    }
    const message = error?.message || 'Image upload failed.'
    throw new Error(message)
  }

  const fileId = responseBody?.file_id || null
  const filePath = responseBody?.file_path || null
  const telegramMessageId = responseBody?.telegram_message_id || null
  const telegramChatId = responseBody?.telegram_chat_id || null
  const resolvedUrl = buildProxyUrl(fileId || filePath)

  if (!resolvedUrl && !responseBody?.url) {
    throw new Error('Image upload failed.')
  }

  return {
    url: resolvedUrl || responseBody.url,
    public_id: null,
    file_id: fileId,
    file_path: filePath,
    telegram_message_id: telegramMessageId,
    telegram_chat_id: telegramChatId,
  }
}

export async function uploadSingleImage(file) {
  if (!file || typeof file !== 'object') {
    throw new Error('No image file was provided.')
  }
  const cachedUpload = imageUploadCache.get(file)
  if (cachedUpload) return cachedUpload

  const uploadPromise = performImageUpload(file)
  imageUploadCache.set(file, uploadPromise)
  try {
    return await uploadPromise
  } catch (error) {
    imageUploadCache.delete(file)
    throw error
  }
}

export async function uploadMultipleImages(files, { onStatus } = {}) {
  if (!files?.length) {
    return { success: [], completed: [], failedCount: 0, errors: [] }
  }

  const results = await Promise.allSettled(files.map(async (file) => {
    onStatus?.(file, 'uploading')
    try {
      const image = await uploadSingleImage(file)
      onStatus?.(file, 'uploaded')
      return { file, image }
    } catch (error) {
      onStatus?.(file, 'failed')
      throw error
    }
  }))
  const completed = results
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value)
  const success = completed.map(({ image }) => image)
  const failedResults = results.filter((result) => result.status === 'rejected')
  const failedCount = failedResults.length
  const errors = results.flatMap((result, index) => {
    if (result.status !== 'rejected') return []
    const filename = files[index]?.name || `Image ${index + 1}`
    return [`${filename}: ${result.reason?.message || 'Image upload failed.'}`]
  })

  return {
    success,
    completed,
    failedCount,
    errors,
  }
}