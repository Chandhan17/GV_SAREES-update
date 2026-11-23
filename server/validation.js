import { z } from 'zod'

const imageMetadataSchema = z.object({
  url: z.string().max(2048).optional(),
  public_id: z.string().max(256).nullable().optional(),
  file_id: z.string().max(512).nullable().optional(),
  file_path: z.string().max(1024).nullable().optional(),
  telegram_message_id: z.union([z.number().int().positive(), z.string().regex(/^[0-9]+$/)]).nullable().optional(),
  telegram_chat_id: z.union([z.string(), z.number()]).nullable().optional(),
}).strict()

const productImageSchema = z.union([
  z.string().max(2048),
  imageMetadataSchema,
])

export const productCreateSchema = z.object({
  action: z.literal('create'),
  name: z.string().trim().min(1).max(120),
  price: z.number().finite().positive().max(50000000),
  category: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(5000),
  fabric: z.string().trim().min(1).max(100),
  images: z.array(productImageSchema).min(1).max(50),
  sizeLength: z.string().trim().max(100).default(''),
  sizeChartText: z.string().trim().max(500).default(''),
  sizeChartImage: z.union([z.string().max(2048), imageMetadataSchema, z.null()]).optional(),
  totalStock: z.number().int().min(0).max(100000),
  lowStockThreshold: z.number().int().min(0).max(100000),
}).strict()

export const deleteTelegramSchema = z.object({
  items: z
    .array(
      z
        .object({
          telegram_message_id: z.union([z.number().int().positive(), z.string().regex(/^[0-9]+$/)]).optional(),
          message_id: z.union([z.number().int().positive(), z.string().regex(/^[0-9]+$/)]).optional(),
          telegram_chat_id: z.union([z.string(), z.number()]).optional(),
          chat_id: z.union([z.string(), z.number()]).optional(),
        })
        .superRefine((value, context) => {
          if (!value.telegram_message_id && !value.message_id) {
            context.addIssue({
              code: 'custom',
              message: 'A Telegram message ID is required.',
              path: ['message_id'],
            })
          }
        })
    )
    .min(1)
    .max(50),
})

export const razorpayOrderSchema = z.object({
  amount: z.number().int().positive().max(50000000),
  currency: z.string().optional().default('INR'),
  receipt: z.string().max(100).optional(),
})

export const reservationSchema = z.object({
  productId: z.string().min(1).max(128),
  quantity: z.number().int().positive().max(100),
  selectedSize: z.string().max(100).optional().default(''),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  customer: z.object({
    name: z.string().trim().min(1).max(120),
    phone: z.string().trim().min(5).max(30),
    address: z.string().trim().min(1).max(500),
  }),
})

export const inventoryAdjustmentSchema = z.object({
  action: z.enum(['adjust', 'set-threshold']),
  productId: z.string().min(1).max(128),
  quantityChange: z.number().int().optional(),
  lowStockThreshold: z.number().int().min(0).max(100000).optional(),
  reason: z.string().trim().min(1).max(240),
}).superRefine((value, context) => {
  if (value.action === 'adjust' && (!Number.isInteger(value.quantityChange) || value.quantityChange === 0)) {
    context.addIssue({ code: 'custom', path: ['quantityChange'], message: 'A non-zero integer stock adjustment is required.' })
  }
  if (value.action === 'set-threshold' && !Number.isInteger(value.lowStockThreshold)) {
    context.addIssue({ code: 'custom', path: ['lowStockThreshold'], message: 'A low-stock threshold is required.' })
  }
})

export const adminReservationSchema = z.object({
  action: z.enum(['confirm', 'release', 'restock-cancelled', 'expire']),
  reservationId: z.string().min(1).max(128),
  reason: z.string().trim().max(240).optional(),
})

export const customerReservationCancellationSchema = z.object({
  reservationId: z.string().uuid(),
  cancellationToken: z.string().regex(/^[a-f0-9]{64}$/i),
})

export const adminOrderActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status'), orderId: z.string().min(1).max(128), orderStatus: z.enum(['initiated', 'confirmed', 'completed']) }),
  z.object({ action: z.literal('archive'), orderId: z.string().min(1).max(128) }),
])
