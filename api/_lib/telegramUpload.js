import axios from 'axios'
import FormData from 'form-data'
import multer from 'multer'
import sharp from 'sharp'
import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'

const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024
const MAX_MULTIPART_BODY_SIZE_BYTES = MAX_IMAGE_SIZE_BYTES + 64 * 1024
const MULTIPART_BODY_READ_TIMEOUT_MS = 30_000

function findPropertyDescriptor(target, property) {
  let current = target
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, property)
    if (descriptor) return descriptor
    current = Object.getPrototypeOf(current)
  }
  return null
}

function getBodyValueType(value) {
  if (Buffer.isBuffer(value)) return 'buffer'
  if (value instanceof Uint8Array) return 'uint8array'
  if (typeof value === 'string') return 'string'
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'object') return 'object'
  return typeof value
}

function describeRequestBodyProperty(req, property) {
  const descriptor = findPropertyDescriptor(req, property)
  if (!descriptor) return { present: false, type: 'undefined' }
  if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    return { present: true, type: 'accessor' }
  }

  const value = descriptor.value
  const type = getBodyValueType(value)
  const byteLength = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? value.byteLength
    : typeof value === 'string'
      ? Buffer.byteLength(value)
      : undefined

  return {
    present: true,
    type,
    ...(byteLength === undefined ? {} : { byteLength }),
  }
}

function getBufferedRawBody(req) {
  for (const property of ['rawBody', 'body']) {
    const descriptor = findPropertyDescriptor(req, property)
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) continue

    const value = descriptor.value
    if (Buffer.isBuffer(value)) return value
    if (value instanceof Uint8Array) return Buffer.from(value)
  }
  return null
}

function readRequestBody(req) {
  const rawBody = getBufferedRawBody(req)
  if (rawBody) {
    if (rawBody.length > MAX_MULTIPART_BODY_SIZE_BYTES) {
      return Promise.reject(Object.assign(new Error('Multipart request is too large.'), {
        code: 'MULTIPART_BODY_TOO_LARGE',
      }))
    }
    return Promise.resolve(rawBody)
  }

  const contentLength = Number(req.headers?.['content-length'])
  if (Number.isFinite(contentLength) && contentLength > MAX_MULTIPART_BODY_SIZE_BYTES) {
    return Promise.reject(Object.assign(new Error('Multipart request is too large.'), {
      code: 'MULTIPART_BODY_TOO_LARGE',
    }))
  }

  return new Promise((resolve, reject) => {
    const chunks = []
    let length = 0
    let tooLarge = false
    let settled = false

    const cleanup = () => {
      clearTimeout(timeout)
      req.removeListener?.('data', onData)
      req.removeListener?.('end', onEnd)
      req.removeListener?.('error', onError)
    }
    const finish = (error, body) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve(body)
    }
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      length += buffer.length
      if (length > MAX_MULTIPART_BODY_SIZE_BYTES) {
        tooLarge = true
        chunks.length = 0
        return
      }
      if (!tooLarge) chunks.push(buffer)
    }
    const onEnd = () => {
      if (tooLarge) {
        finish(Object.assign(new Error('Multipart request is too large.'), {
          code: 'MULTIPART_BODY_TOO_LARGE',
        }))
        return
      }
      finish(null, Buffer.concat(chunks, length))
    }
    const onError = (error) => finish(error)
    const timeout = setTimeout(() => {
      finish(Object.assign(new Error('Original multipart request bytes are unavailable.'), {
        code: 'MULTIPART_BODY_UNAVAILABLE',
      }))
    }, MULTIPART_BODY_READ_TIMEOUT_MS)

    if (typeof req.on !== 'function') {
      finish(Object.assign(new Error('Original multipart request bytes are unavailable.'), {
        code: 'MULTIPART_BODY_UNAVAILABLE',
      }))
      return
    }

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

function createMulterRequest(req, rawBody) {
  // Vercel Dev replays data/end listeners but does not restore the request's pipeable stream.
  const replay = Readable.from([rawBody], { objectMode: false })
  replay.headers = req.headers
  replay.method = req.method
  replay.url = req.url
  return replay
}

export function logUploadRequestDiagnostics(req, stage) {
  if (process.env.NODE_ENV === 'production' && stage !== 'vercel route entry') return

  // Inspect descriptors so diagnostics never invoke lazy body parsers.
  const contentType = String(req.headers?.['content-type'] || '')

  console.info('[telegram-upload] request', {
    stage,
    method: req.method || null,
    contentType: contentType || null,
    boundaryPresent: /(?:^|;)\s*boundary=(?:"[^"]+"|[^;\s]+)/i.test(contentType),
    contentLength: req.headers?.['content-length'] || null,
    body: describeRequestBodyProperty(req, 'body'),
    rawBody: describeRequestBodyProperty(req, 'rawBody'),
    streamReadable: Boolean(req.readable),
    streamEnded: Boolean(req.readableEnded),
    streamDestroyed: Boolean(req.destroyed),
  })
}

function logUploadParserError(error, req) {
  const contentType = String(req.headers?.['content-type'] || '')
  console.error('[telegram-upload] multipart parser error', {
    name: error?.name || 'Unknown',
    code: error?.code || null,
    message: isPerformanceTestMode()
      ? 'Multipart parser failed.'
      : error?.message || 'Unknown multipart parser error',
    boundaryPresent: hasMultipartBoundary(contentType),
    contentLength: req.headers?.['content-length'] || null,
    body: describeRequestBodyProperty(req, 'body'),
    rawBody: describeRequestBodyProperty(req, 'rawBody'),
    streamReadable: Boolean(req.readable),
    streamEnded: Boolean(req.readableEnded),
    streamDestroyed: Boolean(req.destroyed),
  })
}

function hasMultipartBoundary(contentType) {
  return /(?:^|;)\s*boundary=(?:"[^"]+"|[^;\s]+)/i.test(contentType)
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(payload))
}

function sendError(res, statusCode, message) {
  return sendJson(res, statusCode, { success: false, message })
}

async function parseJsonBody(req) {
  if (req.body && typeof req.body === 'object') {
    return req.body
  }

  if (typeof req.body === 'string' && req.body.trim()) {
    return JSON.parse(req.body)
  }

  const chunks = []
  for await (const chunk of req) {
    chunks.push(chunk)
  }

  const rawBody = Buffer.concat(chunks).toString('utf8')
  return rawBody ? JSON.parse(rawBody) : {}
}

function isDevelopmentEnv() {
  return process.env.NODE_ENV !== 'production'
}

function isPerformanceTestMode() {
  return process.env.APP_MODE === 'performance' || process.env.TELEGRAM_TEST_MODE === '1'
}

function buildTelegramProxyUrl(fileId) {
  if (!fileId) return ''

  const configuredBase = String(process.env.VERCEL_URL || process.env.VITE_API_BASE_URL || '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '')

  const proxyPath = `/api/image/${encodeURIComponent(fileId)}`
  return configuredBase ? `https://${configuredBase}${proxyPath}` : proxyPath
}

function resolveTelegramReference(fileRef) {
  let decoded = ''
  try {
    decoded = decodeURIComponent(String(fileRef || '').trim())
  } catch {
    decoded = String(fileRef || '').trim()
  }

  decoded = decoded.replace(/^\/+/, '')

  if (!decoded) {
    return null
  }

  if (decoded.includes('/')) {
    return { type: 'file_path', value: decoded }
  }

  return { type: 'file_id', value: decoded }
}

function getMimeTypeFromPath(path = '') {
  const lower = String(path || '').toLowerCase()

  if (lower.endsWith('.png')) {
    return 'image/png'
  }

  if (lower.endsWith('.webp')) {
    return 'image/webp'
  }

  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    return 'image/jpeg'
  }

  return 'image/jpeg'
}

function getFileNameFromPath(path = '', fallbackName = 'image.jpg') {
  const rawName = String(path || '')
    .split('/')
    .filter(Boolean)
    .pop()

  const sanitized = String(rawName || fallbackName).replace(/["]+/g, '').trim()
  return sanitized || fallbackName
}

function runMiddleware(req, res, middleware) {
  return new Promise((resolve, reject) => {
    middleware(req, res, (error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })
}

function createUploadMiddleware() {
  const storage = multer.memoryStorage()

  const allowedMimes = new Set(['image/jpeg', 'image/png', 'image/webp'])

  return multer({
    storage,
    limits: {
      fileSize: MAX_IMAGE_SIZE_BYTES,
    },
    fileFilter: (req, file, callback) => {
      const mime = String(file.mimetype || '').toLowerCase()
      if (!allowedMimes.has(mime)) {
        callback(new Error('Only JPEG, PNG or WEBP images are allowed.'))
        return
      }

      callback(null, true)
    },
    filename: (req, file, cb) => {
      // multer memoryStorage ignores filename, but keep sanitizer here if changed to disk
      const original = String(file.originalname || 'upload')
      const sanitized = original.replace(/[^a-zA-Z0-9._-]/g, '_')
      cb(null, sanitized)
    },
  }).single('image')
}

function getTelegramErrorMessage(error, fallbackMessage) {
  if (axios.isAxiosError(error)) {
    const telegramMessage =
      error.response?.data?.description ||
      error.response?.data?.error ||
      error.response?.data?.message

    if (telegramMessage) {
      return telegramMessage
    }
  }

  return error?.message || fallbackMessage
}

function getSafeErrorDetails(error) {
  if (!error) return 'Unknown error'

  if (axios.isAxiosError(error)) {
    const status = error.response?.status
    const data = error.response?.data

    if (typeof data === 'string') {
      return {
        status,
        data,
      }
    }

    if (data && typeof data === 'object' && !data.pipe) {
      return {
        status,
        data,
      }
    }

    return {
      status,
      message: error.message,
    }
  }

  if (error?.telegramResponse) {
    return {
      status: error.statusCode || 500,
      data: error.telegramResponse,
    }
  }

  return error?.message || String(error)
}

async function optimizeImage(buffer) {
  try {
    return await sharp(buffer)
      .resize({
        width: 1200,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 80 })
      .toBuffer()
  } catch {
    throw Object.assign(new Error('Uploaded file is not a valid image.'), { code: 'INVALID_IMAGE' })
  }
}

async function uploadImageToTelegram({ buffer, telegramToken, telegramChannelId }) {
  const optimizedBuffer = await optimizeImage(buffer)
  const formData = new FormData()

  formData.append('chat_id', telegramChannelId)
  formData.append('photo', optimizedBuffer, {
    filename: `telegram-upload-${Date.now()}.webp`,
    contentType: 'image/webp',
  })

  const sendPhotoResponse = await axios.post(
    `https://api.telegram.org/bot${telegramToken}/sendPhoto`,
    formData,
    {
      headers: formData.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    }
  )

  const fileId = sendPhotoResponse?.data?.result?.photo?.at(-1)?.file_id

  if (!fileId) {
    throw new Error('Telegram upload succeeded, but no file_id was returned.')
  }

  const fileResponse = await axios.get(
    `https://api.telegram.org/bot${telegramToken}/getFile`,
    {
      params: { file_id: fileId },
    }
  )

  const filePath = fileResponse?.data?.result?.file_path
  const messageId = sendPhotoResponse?.data?.result?.message_id || null
  const chatId = sendPhotoResponse?.data?.result?.chat?.id || telegramChannelId || null

  if (!filePath) {
    throw new Error('Telegram file path was not returned.')
  }

  return {
    file_id: fileId,
    file_path: filePath,
    telegram_message_id: messageId,
    telegram_chat_id: chatId,
    url: buildTelegramProxyUrl(fileId),
  }
}

function normalizeTelegramDeleteItems(rawItems = []) {
  if (!Array.isArray(rawItems)) {
    return []
  }

  return rawItems
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null
      }

      const messageId = item.telegram_message_id || item.message_id || null
      const chatId = item.telegram_chat_id || item.chat_id || null

      if (!messageId) {
        return null
      }

      return {
        message_id: messageId,
        chat_id: chatId,
      }
    })
    .filter(Boolean)
}

function isAlreadyDeletedTelegramError(error) {
  const description = String(error?.response?.data?.description || '').toLowerCase()
  return description.includes('message to delete not found') || description.includes('message can\'t be deleted')
}

async function getTelegramFileMeta({ telegramToken, fileId }) {
  const telegramResponse = await axios.get(
    `https://api.telegram.org/bot${telegramToken}/getFile`,
    {
      params: { file_id: fileId },
    }
  )

  if (!telegramResponse.data?.ok || !telegramResponse.data?.result?.file_path) {
    const error = new Error('Telegram file path not found')
    error.statusCode = 404
    error.telegramResponse = telegramResponse.data
    throw error
  }

  const filePath = telegramResponse.data.result.file_path

  // Log response status and filePath (production-safe, no token)
  try {
    console.log('getTelegramFileMeta', { status: telegramResponse.status, filePath })
  } catch (error) {
    if (error?.code !== 'EPIPE') {
      process.emitWarning('Telegram file metadata logging failed.')
    }
  }

  return {
    file_path: filePath,
    file_url: `https://api.telegram.org/file/bot${telegramToken}/${filePath}`,
    telegramResponse: telegramResponse.data,
  }
}

async function fetchTelegramFileStream({ telegramToken, decodedFileId }) {
  const reference = resolveTelegramReference(decodedFileId)

  if (!reference) {
    throw new Error('Image file ID is required.')
  }

  const filePath =
    reference.type === 'file_path'
      ? reference.value
      : (await getTelegramFileMeta({ telegramToken, fileId: reference.value })).file_path

  const telegramFileUrl = `https://api.telegram.org/file/bot${telegramToken}/${filePath}`
  if (isDevelopmentEnv()) {
    console.log('Telegram download URL resolved (redacted)')
  }

  // Request the file stream from Telegram (don't log the full URL as it contains the bot token)
  const imageResponse = await axios.get(telegramFileUrl, {
    responseType: 'stream',
  })

  try {
    console.log('fetchTelegramFileStream', { filePath, status: imageResponse.status })
  } catch (error) {
    if (error?.code !== 'EPIPE') {
      process.emitWarning('Telegram file stream logging failed.')
    }
  }

  return {
    imageResponse,
    reference,
    filePath,
    telegramFileUrl,
  }
}

function getQueryFileId(req) {
  const raw = req?.query?.fileId
  const first = Array.isArray(raw) ? raw.join('/') : raw

  if (first) {
    try {
      return decodeURIComponent(String(first)).replace(/^\/+/, '')
    } catch {
      return String(first).replace(/^\/+/, '')
    }
  }

  const requestUrl = new URL(req.url || '/', 'http://localhost')
  const fromPath = requestUrl.pathname.replace(/^\/api\/image\//, '')
  try {
    return decodeURIComponent(fromPath).replace(/^\/+/, '')
  } catch {
    return fromPath.replace(/^\/+/, '')
  }
}

export function createTelegramImageHandler({
  telegramToken,
  telegramChannelId,
  uploadImage = uploadImageToTelegram,
}) {
  const upload = createUploadMiddleware()

  return async function telegramImageHandler(req, res) {
    logUploadRequestDiagnostics(req, 'multer input')

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      return sendJson(res, 405, { error: 'Method Not Allowed' })
    }

    if (!telegramToken || !telegramChannelId) {
      return sendJson(res, 500, {
        error: 'Telegram credentials are missing.',
      })
    }

    const contentType = String(req.headers?.['content-type'] || '')
    if (!/^multipart\/form-data(?:\s*;|$)/i.test(contentType)) {
      return sendJson(res, 415, { error: 'Expected a multipart/form-data image upload.' })
    }
    if (!hasMultipartBoundary(contentType)) {
      return sendJson(res, 400, {
        error: 'Multipart boundary is missing. Do not set Content-Type manually when sending FormData.',
      })
    }

    try {
      const requestBody = await readRequestBody(req)
      const multipartRequest = createMulterRequest(req, requestBody)
      try {
        await runMiddleware(multipartRequest, res, upload)
      } catch (error) {
        logUploadParserError(error, req)
        throw error
      }

      logUploadRequestDiagnostics(multipartRequest, 'multer parsed')
      if (process.env.NODE_ENV !== 'production') {
        console.info('[telegram-upload] parsed file', {
          imageFieldReceived: Boolean(multipartRequest.file),
          fieldName: multipartRequest.file?.fieldname || null,
          fileSize: multipartRequest.file?.size ?? null,
          mimeType: multipartRequest.file?.mimetype || null,
        })
      }

      if (!multipartRequest.file) {
        return sendJson(res, 400, { error: 'An image file is required.' })
      }

      if (!multipartRequest.file.size) {
        return sendJson(res, 400, { error: 'Image file is empty.' })
      }

      if (!multipartRequest.file.mimetype?.startsWith('image/')) {
        return sendJson(res, 400, { error: 'Only image files are allowed.' })
      }

      const result = await uploadImage({
        buffer: multipartRequest.file.buffer,
        telegramToken,
        telegramChannelId,
      })

      return sendJson(res, 200, result)
    } catch (error) {
      if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
          return sendJson(res, 413, { error: 'Image must be 5MB or smaller.' })
        }
        if (error.code === 'LIMIT_UNEXPECTED_FILE') {
          return sendJson(res, 400, { error: 'Unexpected upload field; expected "image".' })
        }

        return sendJson(res, 400, { error: 'Invalid image upload.' })
      }

      if (error?.code === 'MULTIPART_BODY_TOO_LARGE') {
        return sendJson(res, 413, { error: 'Multipart request is too large.' })
      }

      if (error?.code === 'MULTIPART_BODY_UNAVAILABLE') {
        return sendJson(res, 400, { error: error.message })
      }

      if (error?.code === 'INVALID_IMAGE') {
        return sendJson(res, 400, { error: error.message })
      }

      if (['Only image files are allowed.', 'Only JPEG, PNG or WEBP images are allowed.'].includes(error?.message)) {
        return sendJson(res, 400, { error: error.message })
      }

      if (['Unexpected end of form', 'Unexpected end of file', 'Malformed part header', 'Multipart: Boundary not found'].includes(error?.message)) {
        return sendJson(res, 400, { error: 'Malformed multipart upload.' })
      }

      return sendJson(res, axios.isAxiosError(error) ? 502 : 500, {
        error: getTelegramErrorMessage(error, 'Unable to upload image to Telegram.'),
      })
    }
  }
}

export function createTelegramImageProxyHandler({ telegramToken }) {
  return async function telegramImageProxyHandler(req, res) {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET')
      return sendError(res, 405, 'Method Not Allowed')
    }

    if (!telegramToken) {
      console.error('Missing TELEGRAM_BOT_TOKEN in environment for image proxy')
      return sendError(res, 500, 'Telegram credentials are missing.')
    }

    try {
      const decodedFileId = getQueryFileId(req)
      if (isDevelopmentEnv()) {
        console.log('Incoming image proxy fileId:', decodedFileId)
      }

      if (!decodedFileId) {
        return sendError(res, 400, 'Image file ID is required.')
      }

      const { imageResponse, reference, filePath } = await fetchTelegramFileStream({
        telegramToken,
        decodedFileId,
      })

      if (!imageResponse?.data) {
        return sendJson(res, 500, { error: 'No image stream returned' })
      }

      if (isDevelopmentEnv()) {
        console.log('Resolved proxy filePath:', filePath)
        console.log('Streaming image now...')
      }

      // Production-safe logging for proxy action (no token printed)
      try {
        console.log('Proxying Telegram file', { filePath, referenceType: reference.type, proxiedStatus: imageResponse.status })
      } catch (error) {
        if (error?.code !== 'EPIPE') {
          process.emitWarning('Telegram image proxy logging failed.')
        }
      }

      const contentType = imageResponse.headers['content-type']
      const safeContentType =
        contentType && contentType !== 'application/octet-stream'
          ? contentType
          : getMimeTypeFromPath(filePath)

      res.statusCode = 200
      res.removeHeader('Content-Disposition')
      res.setHeader('Content-Type', safeContentType || 'image/jpeg')
      res.setHeader('Content-Disposition', `inline; filename="${getFileNameFromPath(filePath, 'image.jpg')}"`)
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Access-Control-Allow-Origin', '*')

      const contentLength = imageResponse.headers['content-length']
      if (contentLength) {
        res.setHeader('Content-Length', contentLength)
      }

      req.on('close', () => {
        if (imageResponse?.data?.destroy) {
          imageResponse.data.destroy()
        }
      })

      imageResponse.data.on('end', () => {
        if (isDevelopmentEnv()) {
          console.log('Telegram image stream completed')
        }
      })

      imageResponse.data.on('error', (streamError) => {
        if (isPerformanceTestMode()) {
          console.error('Telegram test image stream failed.')
        } else {
          console.error('Image stream error:', streamError)
        }

        if (!res.headersSent) {
          sendJson(res, 500, {
            error: 'Image stream failed',
          })
          return
        }

        res.end()
      })

      imageResponse.data.pipe(res)
    } catch (error) {
      const errorDetails = isPerformanceTestMode()
        ? { status: Number(error?.statusCode) || Number(error?.response?.status) || 500 }
        : getSafeErrorDetails(error)
      console.error('Telegram image proxy error:', errorDetails)

      if (res.headersSent) {
        res.end()
        return
      }

      const statusCode = Number(error?.statusCode) || Number(error?.response?.status) || 500
      if (isPerformanceTestMode()) {
        return sendError(res, statusCode, 'Unable to fetch image from the Telegram test channel.')
      }
      const message =
        statusCode === 404
          ? 'Telegram file path not found'
          : getTelegramErrorMessage(error, 'Unable to fetch image from Telegram.')

      if (isDevelopmentEnv()) {
        return sendJson(res, statusCode, {
          error: message,
          details: errorDetails,
        })
      }

      return sendError(res, statusCode, message)
    }
  }
}

export function createTelegramMediaDeleteHandler({ telegramToken, telegramChannelId }) {
  return async function telegramMediaDeleteHandler(req, res) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      return sendError(res, 405, 'Method Not Allowed')
    }

    if (!telegramToken || !telegramChannelId) {
      return sendError(res, 500, 'Telegram credentials are missing.')
    }

    try {
      const body = await parseJsonBody(req)
      const items = normalizeTelegramDeleteItems(body?.items || body?.images || [])

      if (!items.length) {
        return sendJson(res, 200, {
          deletedCount: 0,
          skippedCount: Array.isArray(body?.items || body?.images) ? (body.items || body.images).length : 0,
          failedCount: 0,
          failures: [],
        })
      }

      const failures = []
      let deletedCount = 0

      for (const item of items) {
        const chatId = item.chat_id || telegramChannelId

        try {
          const telegramResponse = await axios.post(
            `https://api.telegram.org/bot${telegramToken}/deleteMessage`,
            {
              chat_id: chatId,
              message_id: item.message_id,
            }
          )

          if (telegramResponse?.data?.ok) {
            deletedCount += 1
            continue
          }

          failures.push({
            message_id: item.message_id,
            reason: telegramResponse?.data?.description || 'Unable to delete Telegram message.',
          })
        } catch (error) {
          if (isAlreadyDeletedTelegramError(error)) {
            deletedCount += 1
            continue
          }

          failures.push({
            message_id: item.message_id,
            reason: getTelegramErrorMessage(error, 'Unable to delete Telegram message.'),
          })
        }
      }

      return sendJson(res, 200, {
        deletedCount,
        skippedCount: (Array.isArray(body?.items || body?.images) ? (body.items || body.images).length : 0) - items.length,
        failedCount: failures.length,
        failures,
      })
    } catch (error) {
      return sendJson(res, 500, {
        error: getTelegramErrorMessage(error, 'Unable to delete Telegram media.'),
      })
    }
  }
}