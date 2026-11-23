import { readFileSync } from 'node:fs'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

export function inventoryMigrationPatch(existing, confirmedTotalStock) {
  if (!Number.isInteger(confirmedTotalStock) || confirmedTotalStock < 0) {
    throw new Error('Every migrated product requires a confirmed non-negative integer stock quantity.')
  }
  const reservedStock = Number.isInteger(existing.reservedStock) ? existing.reservedStock : 0
  const lowStockThreshold = Number.isInteger(existing.lowStockThreshold) ? existing.lowStockThreshold : 2
  if (reservedStock < 0 || confirmedTotalStock < reservedStock) {
    throw new Error('Confirmed physical stock cannot be below the product reserved quantity.')
  }
  const availableStock = confirmedTotalStock - reservedStock
  const patch = {
    totalStock: confirmedTotalStock,
    reservedStock,
    availableStock,
    inStock: availableStock > 0,
    lowStockThreshold,
  }
  const alreadyInitialized = ['totalStock', 'reservedStock', 'availableStock', 'inStock', 'lowStockThreshold']
    .every((field) => Object.prototype.hasOwnProperty.call(existing, field) && existing[field] === patch[field])
  return { patch, alreadyInitialized }
}

function parseArgs(argv) {
  const inputIndex = argv.indexOf('--input')
  return {
    inputFile: inputIndex >= 0 ? argv[inputIndex + 1] : '',
    apply: argv.includes('--apply'),
    confirmed: argv.includes('--confirm-stock'),
  }
}

function initializeFirebaseAdmin() {
  if (getApps().length) return
  let credential = applicationDefault()
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    credential = cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON))
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_FILE) {
    credential = cert(JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_FILE, 'utf8')))
  }
  initializeApp({
    credential,
    projectId: process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT,
  })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.inputFile) throw new Error('Usage: node scripts/migrateInventory.js --input stock-confirmations.json [--apply --confirm-stock]')
  if (args.apply && !args.confirmed) throw new Error('Applying requires --confirm-stock after reviewing the dry run.')
  const quantities = JSON.parse(readFileSync(args.inputFile, 'utf8'))
  if (!quantities || typeof quantities !== 'object' || Array.isArray(quantities)) {
    throw new Error('Input must be a JSON object mapping product document IDs to confirmed physical stock quantities.')
  }
  initializeFirebaseAdmin()
  const db = getFirestore()
  let updated = 0
  let skipped = 0

  for (const [productId, quantity] of Object.entries(quantities)) {
    const ref = db.collection('products').doc(productId)
    if (!args.apply) {
      const snapshot = await ref.get()
      if (!snapshot.exists) throw new Error(`Product not found: ${productId}`)
      const { patch, alreadyInitialized } = inventoryMigrationPatch(snapshot.data(), quantity)
      if (alreadyInitialized) {
        skipped += 1
      } else {
        console.log(`Would initialize ${productId}: total=${patch.totalStock}, reserved=${patch.reservedStock}, available=${patch.availableStock}`)
        updated += 1
      }
      continue
    }

    const outcome = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref)
      if (!snapshot.exists) throw new Error(`Product not found: ${productId}`)
      const { patch, alreadyInitialized } = inventoryMigrationPatch(snapshot.data(), quantity)
      if (!alreadyInitialized) transaction.update(ref, patch)
      return alreadyInitialized
    })
    if (outcome) skipped += 1
    else updated += 1
  }

  console.log(`Mode: ${args.apply ? 'apply' : 'dry-run'}`)
  console.log(`Products supplied: ${Object.keys(quantities).length}`)
  console.log(`Products initialized: ${updated}`)
  console.log(`Already initialized: ${skipped}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('Inventory migration failed:', error.message)
    process.exitCode = 1
  })
}
