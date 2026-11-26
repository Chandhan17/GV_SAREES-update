import { initializeApp } from 'firebase-admin/app'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'
import process from 'node:process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  PERFORMANCE_FIRESTORE_HOST,
  PERFORMANCE_PROJECT_ID,
  readPerformanceEnvironment,
  verifyFirestoreEmulator,
} from '../server/performanceSafety.js'

export const PERFORMANCE_PLACEHOLDER_IMAGE = '/performance-placeholder.svg'

const DAY_MS = 24 * 60 * 60 * 1000
const SEED_REFERENCE_TIME = Date.UTC(2026, 10, 25, 12)

export const PERFORMANCE_SEED_PRODUCTS = Object.freeze([
  {
    id: 'performance-seed-v1-001',
    name: 'Kanchi Pattu Celebration Saree',
    price: 8499,
    category: 'Pattu',
    description: 'Traditional Kanchi-inspired pattu styling with a rich woven border.',
    fabric: 'Kanchi pattu',
    sizeLength: '5.5 m + 0.8 m blouse piece',
    sizeChartText: 'Saree length: 5.5 m; blouse piece: 0.8 m.',
    totalStock: 8,
    lowStockThreshold: 2,
  },
  {
    id: 'performance-seed-v1-002',
    name: 'Banarasi Bridal Brocade Saree',
    price: 12999,
    category: 'Bridal Collection',
    description: 'A festive brocade-style drape for wedding and celebration wear.',
    fabric: 'Dharmavaram pattu',
    sizeLength: '5.5 m + 0.8 m blouse piece',
    sizeChartText: 'Saree length: 5.5 m; blouse piece: 0.8 m.',
    totalStock: 4,
    lowStockThreshold: 2,
  },
  {
    id: 'performance-seed-v1-003',
    name: 'Floral Dola Silk Fancy Saree',
    price: 2499,
    category: 'Fancy',
    description: 'A light occasion saree with a soft sheen and floral-inspired detailing.',
    fabric: 'Dola silk',
    sizeLength: '5.5 m',
    sizeChartText: 'Saree length: 5.5 m.',
    totalStock: 12,
    lowStockThreshold: 2,
  },
  {
    id: 'performance-seed-v1-004',
    name: 'Chettinadu Handloom Cotton Saree',
    price: 1799,
    category: 'Cotton',
    description: 'An easy everyday cotton drape with a classic handloom look.',
    fabric: 'Chettinadu cotton',
    sizeLength: '6.2 m',
    sizeChartText: 'Saree length: 6.2 m.',
    totalStock: 15,
    lowStockThreshold: 3,
  },
  {
    id: 'performance-seed-v1-005',
    name: 'Kota Doria Everyday Saree',
    price: 2199,
    category: 'Kota',
    description: 'A lightweight Kota-style saree suited to relaxed daytime wear.',
    fabric: 'Kota cotton',
    sizeLength: '5.5 m',
    sizeChartText: 'Saree length: 5.5 m.',
    totalStock: 9,
    lowStockThreshold: 2,
  },
  {
    id: 'performance-seed-v1-006',
    name: 'Mangalagiri Handloom Cotton Saree',
    price: 2899,
    category: 'Mangalagiri',
    description: 'A simple handloom-inspired drape with a clean contrast border.',
    fabric: 'Mangalagiri Handloom',
    sizeLength: '6.2 m',
    sizeChartText: 'Saree length: 6.2 m.',
    totalStock: 6,
    lowStockThreshold: 2,
  },
  {
    id: 'performance-seed-v1-007',
    name: 'Pure Tusser Festive Saree',
    price: 3899,
    category: 'Tusser',
    description: 'A textured festive saree with a warm natural-fibre appearance.',
    fabric: 'Pure tusser',
    sizeLength: '5.5 m + 0.8 m blouse piece',
    sizeChartText: 'Saree length: 5.5 m; blouse piece: 0.8 m.',
    totalStock: 5,
    lowStockThreshold: 2,
  },
  {
    id: 'performance-seed-v1-008',
    name: 'Kalamkari Dress Material Set',
    price: 1499,
    category: 'Dress materials',
    description: 'A coordinated dress-material set with a traditional printed look.',
    fabric: 'Kalamkari pattu',
    sizeLength: '3-piece set',
    sizeChartText: 'Includes top fabric, bottom fabric and dupatta.',
    totalStock: 10,
    lowStockThreshold: 2,
  },
  {
    id: 'performance-seed-v1-009',
    name: 'Zari Border Semi Pattu Saree',
    price: 4599,
    category: 'Semi Pattu',
    description: 'A versatile semi-pattu drape finished with a subtle zari-style border.',
    fabric: 'Semi Pattu',
    sizeLength: '5.5 m + 0.8 m blouse piece',
    sizeChartText: 'Saree length: 5.5 m; blouse piece: 0.8 m.',
    totalStock: 7,
    lowStockThreshold: 2,
  },
  {
    id: 'performance-seed-v1-010',
    name: 'Peacock Motif Fancy Pattu Saree',
    price: 5799,
    category: 'Fancy pattu',
    description: 'A festive pattu-inspired saree with an elegant motif design.',
    fabric: 'Semi Fancy Pattu',
    sizeLength: '5.5 m + 0.8 m blouse piece',
    sizeChartText: 'Saree length: 5.5 m; blouse piece: 0.8 m.',
    totalStock: 3,
    lowStockThreshold: 2,
  },
  {
    id: 'performance-seed-v1-011',
    name: 'Gadwal Temple Border Pattu Saree',
    price: 6999,
    category: 'Pattu',
    description: 'A traditional pattu-inspired saree with a temple-border finish.',
    fabric: 'Gadwal pattu',
    sizeLength: '5.5 m + 0.8 m blouse piece',
    sizeChartText: 'Saree length: 5.5 m; blouse piece: 0.8 m.',
    totalStock: 2,
    lowStockThreshold: 2,
  },
  {
    id: 'performance-seed-v1-012',
    name: 'Bandhini Festive Fancy Saree',
    price: 3299,
    category: 'Fancy',
    description: 'A bright festive drape with a bandhani-inspired pattern.',
    fabric: 'Bandhini sarees',
    sizeLength: '5.5 m',
    sizeChartText: 'Saree length: 5.5 m.',
    totalStock: 11,
    lowStockThreshold: 2,
  },
  {
    id: 'performance-seed-v1-013',
    name: 'Chandheri Silk Occasion Saree',
    price: 5299,
    category: 'Bridal Collection',
    description: 'A graceful occasion saree with a light silk-inspired finish.',
    fabric: 'Chandheri silk',
    sizeLength: '5.5 m + 0.8 m blouse piece',
    sizeChartText: 'Saree length: 5.5 m; blouse piece: 0.8 m.',
    totalStock: 5,
    lowStockThreshold: 2,
  },
  {
    id: 'performance-seed-v1-014',
    name: 'Narayanapeta Cotton Saree',
    price: 2299,
    category: 'Cotton',
    description: 'A comfortable cotton saree inspired by classic Narayanapeta weaves.',
    fabric: 'Narayanapeta',
    sizeLength: '6.2 m',
    sizeChartText: 'Saree length: 6.2 m.',
    totalStock: 8,
    lowStockThreshold: 2,
  },
  {
    id: 'performance-seed-v1-015',
    name: 'Kuppadam Traditional Pattu Saree',
    price: 8999,
    category: 'Pattu',
    description: 'A rich traditional-style pattu saree for special occasions.',
    fabric: 'Kuppadam pattu',
    sizeLength: '5.5 m + 0.8 m blouse piece',
    sizeChartText: 'Saree length: 5.5 m; blouse piece: 0.8 m.',
    totalStock: 4,
    lowStockThreshold: 2,
  },
  {
    id: 'performance-seed-v1-016',
    name: 'Tissue Kota Occasion Saree',
    price: 3999,
    category: 'Kota',
    description: 'A light occasion saree with a tissue-inspired finish.',
    fabric: 'Tissue sarees',
    sizeLength: '5.5 m',
    sizeChartText: 'Saree length: 5.5 m.',
    totalStock: 6,
    lowStockThreshold: 2,
  },
  {
    id: 'performance-seed-v1-017',
    name: 'Semi Tusser Workwear Saree',
    price: 1899,
    category: 'Tusser',
    description: 'A practical daily-wear drape with a soft textured appearance.',
    fabric: 'Semi tusser',
    sizeLength: '5.5 m',
    sizeChartText: 'Saree length: 5.5 m.',
    totalStock: 0,
    lowStockThreshold: 2,
  },
  {
    id: 'performance-seed-v1-018',
    name: 'Mangalagiri Dress Material',
    price: 1299,
    category: 'Dress materials',
    description: 'A versatile dress-material set with a Mangalagiri-inspired weave.',
    fabric: 'Mangalagiri',
    sizeLength: '3-piece set',
    sizeChartText: 'Includes top fabric, bottom fabric and dupatta.',
    totalStock: 13,
    lowStockThreshold: 2,
  },
  {
    id: 'performance-seed-v1-019',
    name: 'Ikkat Pattu Festive Saree',
    price: 7499,
    category: 'Pattu',
    description: 'A celebration-ready pattu-style drape with an ikkat-inspired pattern.',
    fabric: 'Ikkat pattu',
    sizeLength: '5.5 m + 0.8 m blouse piece',
    sizeChartText: 'Saree length: 5.5 m; blouse piece: 0.8 m.',
    totalStock: 7,
    lowStockThreshold: 2,
  },
  {
    id: 'performance-seed-v1-020',
    name: 'Mangalagiri Powerloom Cotton Saree',
    price: 999,
    category: 'Mangalagiri',
    description: 'An affordable everyday cotton drape with a neat woven border.',
    fabric: 'Mangalagiri Powerloom',
    sizeLength: '6.2 m',
    sizeChartText: 'Saree length: 6.2 m.',
    totalStock: 18,
    lowStockThreshold: 3,
  },
])

export function assertPerformanceSeedTarget({
  explicitEnv,
  inheritedEnv = process.env,
} = {}) {
  if (explicitEnv?.FIREBASE_PROJECT_ID !== PERFORMANCE_PROJECT_ID ||
      explicitEnv?.FIRESTORE_EMULATOR_HOST !== PERFORMANCE_FIRESTORE_HOST) {
    throw new Error('Performance product seeding requires demo-gv-sarees and its local Firestore Emulator.')
  }

  const projectKeys = [
    'FIREBASE_PROJECT_ID',
    'GOOGLE_CLOUD_PROJECT',
    'GCLOUD_PROJECT',
    'VITE_FIREBASE_PROJECT_ID',
  ]
  for (const key of projectKeys) {
    if (inheritedEnv[key] && inheritedEnv[key] !== PERFORMANCE_PROJECT_ID) {
      throw new Error('Inherited Firebase project settings conflict with the performance Emulator target.')
    }
  }

  const emulatorKeys = ['FIRESTORE_EMULATOR_HOST', 'VITE_FIRESTORE_EMULATOR_HOST']
  for (const key of emulatorKeys) {
    if (inheritedEnv[key] && inheritedEnv[key] !== PERFORMANCE_FIRESTORE_HOST) {
      throw new Error('Inherited Firestore settings conflict with the performance Emulator target.')
    }
  }

  const credentialKeys = [
    'FIREBASE_SERVICE_ACCOUNT_JSON',
    'FIREBASE_CLIENT_EMAIL',
    'FIREBASE_PRIVATE_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',
  ]
  if (credentialKeys.some((key) => inheritedEnv[key])) {
    throw new Error('Firebase credentials are not allowed when seeding performance data.')
  }

  if (inheritedEnv.FIREBASE_CONFIG) {
    let firebaseConfig
    try {
      firebaseConfig = JSON.parse(inheritedEnv.FIREBASE_CONFIG)
    } catch {
      throw new Error('Inherited Firebase configuration cannot be verified for performance seeding.')
    }
    if (!firebaseConfig || typeof firebaseConfig !== 'object' ||
        firebaseConfig.projectId !== PERFORMANCE_PROJECT_ID) {
      throw new Error('Inherited Firebase configuration conflicts with the performance Emulator target.')
    }
  }

  return {
    projectId: PERFORMANCE_PROJECT_ID,
    emulatorHost: PERFORMANCE_FIRESTORE_HOST,
  }
}

export function createPerformanceSeedDocuments() {
  return PERFORMANCE_SEED_PRODUCTS.map((product, index) => {
    const { id, ...fields } = product
    const totalStock = fields.totalStock
    return {
      id,
      data: {
        ...fields,
        images: [PERFORMANCE_PLACEHOLDER_IMAGE],
        reservedStock: 0,
        availableStock: totalStock,
        inStock: totalStock > 0,
        createdAt: Timestamp.fromMillis(SEED_REFERENCE_TIME - index * DAY_MS),
      },
    }
  })
}

export async function seedPerformanceProducts({
  explicitEnv,
  inheritedEnv = process.env,
  verifyEmulator = verifyFirestoreEmulator,
  createFirestore,
} = {}) {
  const target = assertPerformanceSeedTarget({ explicitEnv, inheritedEnv })
  await verifyEmulator(target)

  if (typeof createFirestore !== 'function') {
    throw new Error('A verified Firestore Emulator client factory is required.')
  }

  const firestore = await createFirestore(target)
  if (!firestore || typeof firestore.collection !== 'function' ||
      typeof firestore.batch !== 'function') {
    throw new Error('The performance Firestore Emulator client is unavailable.')
  }

  const batch = firestore.batch()
  try {
    for (const { id, data } of createPerformanceSeedDocuments()) {
      batch.set(firestore.collection('products').doc(id), data)
    }
    await batch.commit()
  } catch {
    throw new Error('Performance sample products could not be written to the verified Firestore Emulator.')
  }

  return PERFORMANCE_SEED_PRODUCTS.length
}

export async function runPerformanceProductSeed({
  root = process.cwd(),
  inheritedEnv = process.env,
} = {}) {
  const explicitEnv = readPerformanceEnvironment(root)
  return seedPerformanceProducts({
    explicitEnv,
    inheritedEnv,
    createFirestore: ({ projectId, emulatorHost }) => {
      process.env.FIRESTORE_EMULATOR_HOST = emulatorHost
      try {
        const app = initializeApp({ projectId }, 'performance-product-seeder')
        return getFirestore(app)
      } catch {
        throw new Error('Unable to initialize the local Firestore Emulator client.')
      }
    },
  })
}

const invokedPath = process.argv[1]
if (invokedPath && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  runPerformanceProductSeed()
    .then((count) => {
      console.log(`Seeded ${count} sample products in the verified Firestore Emulator.`)
    })
    .catch((error) => {
      console.error(`Performance product seeding failed: ${error.message}`)
      process.exitCode = 1
    })
}
