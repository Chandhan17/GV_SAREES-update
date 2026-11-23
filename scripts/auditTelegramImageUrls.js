import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

const IMAGE_FIELD_PATTERN = /(?:image|images|thumbnail|thumbnails|thumb|thumbs|photo|photos|gallery|galleries)(?:url|urls)?$/
const TELEGRAM_FILE_URL_PATTERN = /https?:\/\/api\.telegram\.org\/file\/bot[^/\\\s?#]+(?:\/[^\s"'<>]*)?/i

function isImageFieldName(name) {
  const normalized = String(name).toLowerCase().replace(/[^a-z]/g, '')
  return IMAGE_FIELD_PATTERN.test(normalized) || normalized === 'sizechartimage' || normalized === 'sizecharturl'
}

function containsTelegramTokenUrl(value) {
  let candidate = value

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (TELEGRAM_FILE_URL_PATTERN.test(candidate)) {
      return true
    }

    try {
      const decoded = decodeURIComponent(candidate)
      if (decoded === candidate) break
      candidate = decoded
    } catch {
      break
    }
  }

  return false
}

function findExposedFields(value, path, fields) {
  if (typeof value === 'string') {
    if (containsTelegramTokenUrl(value)) fields.push(path)
    return
  }

  if (!value || typeof value !== 'object') return

  if (Array.isArray(value)) {
    value.forEach((item, index) => findExposedFields(item, `${path}[${index}]`, fields))
    return
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    findExposedFields(nestedValue, `${path}.${key}`, fields)
  }
}

function auditImageValue(value, path, result, affectedFields) {
  if (value === null || typeof value === 'undefined') return

  if (Array.isArray(value)) {
    value.forEach((item, index) => auditImageValue(item, `${path}[${index}]`, result, affectedFields))
    return
  }

  if (typeof value === 'string' && !value.trim()) return

  const exposedFields = []
  findExposedFields(value, path, exposedFields)
  result.imageReferencesChecked += 1

  if (exposedFields.length) {
    result.potentiallyExposedReferences += 1
    exposedFields.forEach((field) => affectedFields.add(field))
  }
}

function visitProductFields(value, path, result, affectedFields) {
  if (!value || typeof value !== 'object') return

  if (Array.isArray(value)) {
    value.forEach((item, index) => visitProductFields(item, `${path}[${index}]`, result, affectedFields))
    return
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const fieldPath = path ? `${path}.${key}` : key
    if (isImageFieldName(key)) {
      auditImageValue(nestedValue, fieldPath, result, affectedFields)
    } else {
      visitProductFields(nestedValue, fieldPath, result, affectedFields)
    }
  }
}

export function auditProductRecords(records) {
  const result = {
    productDocumentsChecked: records.length,
    imageReferencesChecked: 0,
    potentiallyExposedReferences: 0,
    affectedDocuments: [],
  }

  for (const record of records) {
    const fields = new Set()
    visitProductFields(record.data, '', result, fields)
    if (fields.size) {
      result.affectedDocuments.push({
        documentId: record.id,
        fields: [...fields].sort(),
      })
    }
  }

  result.affectedDocuments.sort((left, right) => left.documentId.localeCompare(right.documentId))
  return result
}

function initializeFirebaseAdminFromEnvironment() {
  if (getApps().length) return

  let credential
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    credential = cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON))
  } else if (
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY &&
    process.env.FIREBASE_PROJECT_ID
  ) {
    credential = cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: String(process.env.FIREBASE_PRIVATE_KEY).replace(/\\n/g, '\n'),
    })
  } else {
    credential = applicationDefault()
  }

  initializeApp({ credential })
}

async function main() {
  initializeFirebaseAdminFromEnvironment()
  const snapshot = await getFirestore().collection('products').get()
  const result = auditProductRecords(
    snapshot.docs.map((document) => ({ id: document.id, data: document.data() }))
  )

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

const isDirectExecution =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url

if (isDirectExecution) {
  main().catch(() => {
    process.stderr.write('Telegram image URL audit failed; no document data was emitted.\n')
    process.exitCode = 1
  })
}
