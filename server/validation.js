import { z } from 'zod'
import {
  buildCustomerAddress,
  normalizeIndianMobileNumber,
} from '../shared/customerValidation.js'

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

export const productUpdateSchema = z.object({
  action: z.literal('update'),
  productId: z.string().min(1).max(128),
  name: z.string().trim().min(1).max(120).optional(),
  price: z.number().finite().positive().max(50000000).optional(),
  category: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().min(1).max(5000).optional(),
  fabric: z.string().trim().min(1).max(100).optional(),
  images: z.array(productImageSchema).min(1).max(50).optional(),
  sizeLength: z.string().trim().max(100).optional(),
  sizeChartText: z.string().trim().max(500).optional(),
  sizeChartImage: z.union([z.string().max(2048), imageMetadataSchema, z.null()]).optional(),
}).strict().superRefine((value, context) => {
  const editableFields = [
    'name',
    'price',
    'category',
    'description',
    'fabric',
    'images',
    'sizeLength',
    'sizeChartText',
    'sizeChartImage',
  ]
  if (!editableFields.some((field) => Object.prototype.hasOwnProperty.call(value, field))) {
    context.addIssue({
      code: 'custom',
      message: 'At least one editable product field is required.',
      path: ['product'],
    })
  }
})

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
  reservationId: z.string().uuid(),
  cancellationToken: z.string().regex(/^[a-f0-9]{64}$/i),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
}).strict()

export const razorpayVerificationSchema = z.object({
  razorpay_order_id: z.string().regex(/^order_[A-Za-z0-9]+$/).max(64),
  razorpay_payment_id: z.string().regex(/^pay_[A-Za-z0-9]+$/).max(64),
  razorpay_signature: z.string().regex(/^[a-f0-9]{64}$/i),
}).strict()

export const razorpayFailureSchema = z.object({
  reservationId: z.string().uuid(),
  cancellationToken: z.string().regex(/^[a-f0-9]{64}$/i),
  razorpay_order_id: z.string().regex(/^order_[A-Za-z0-9]+$/).max(64),
  razorpay_payment_id: z.string().regex(/^pay_[A-Za-z0-9]+$/).max(64).optional(),
}).strict()

export const razorpayDismissalSchema = z.object({
  action: z.literal('checkout-dismissed'),
  reservationId: z.string().uuid(),
  cancellationToken: z.string().regex(/^[a-f0-9]{64}$/i),
  razorpay_order_id: z.string().regex(/^order_[A-Za-z0-9]+$/).max(64),
}).strict()

export const reservationSchema = z.object({
  items: z.array(z.object({
    productId: z.string().min(1).max(128),
    quantity: z.number().int().positive().max(100000),
    selectedSize: z.string().max(100).optional().default(''),
  }).strict()).min(1).max(50).optional(),
  productId: z.string().min(1).max(128).optional(),
  quantity: z.number().int().positive().max(100000).optional(),
  selectedSize: z.string().max(100).optional().default(''),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  customer: z.object({
    name: z.string().trim().min(1).max(120).transform((value) => value.replace(/\s+/g, ' ')),
    phone: z.string()
      .trim()
      .refine((value) => Boolean(normalizeIndianMobileNumber(value)), 'Enter a valid Indian mobile number.')
      .transform((value) => normalizeIndianMobileNumber(value)),
    doorNo: z.string().trim().min(1).max(80).transform((value) => value.replace(/\s+/g, ' ')),
    streetName: z.string().trim().min(1).max(200).transform((value) => value.replace(/\s+/g, ' ')),
    city: z.string().trim().min(1).max(100).transform((value) => value.replace(/\s+/g, ' ')),
    pincode: z.string().trim().regex(/^\d{6}$/, 'PIN code must contain six digits.'),
    state: z.string().trim().min(1).max(100).transform((value) => value.replace(/\s+/g, ' ')),
  }).transform((customer) => ({
    name: customer.name,
    phone: customer.phone,
    address: buildCustomerAddress(customer),
  })),
}).superRefine((value, context) => {
  if (!value.items && (!value.productId || !Number.isInteger(value.quantity))) {
    context.addIssue({
      code: 'custom',
      path: ['items'],
      message: 'At least one valid reservation item is required.',
    })
  }
  if (value.items && (value.productId || value.quantity !== undefined)) {
    context.addIssue({
      code: 'custom',
      path: ['items'],
      message: 'Use either items or the legacy single-product fields, not both.',
    })
  }
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
  action: z.enum(['release', 'restock-cancelled', 'expire', 'retry-refund']),
  reservationId: z.string().min(1).max(128),
  reason: z.string().trim().max(240).optional(),
})

export const customerReservationCancellationSchema = z.object({
  reservationId: z.string().uuid(),
  cancellationToken: z.string().regex(/^[a-f0-9]{64}$/i),
})

export const adminOrderActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('status'),
    orderId: z.string().min(1).max(128),
    orderStatus: z.enum(['initiated', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'completed']),
  }),
  z.object({ action: z.literal('archive'), orderId: z.string().min(1).max(128) }),
  z.object({
    action: z.literal('delete'),
    orderIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)).min(1).max(100),
  }),
  z.object({
    action: z.literal('permanent-delete'),
    orderIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)).min(1).max(100),
    backupDisposition: z.enum(['exported', 'skipped']),
  }),
]).superRefine((value, context) => {
    if (
      ['delete', 'permanent-delete'].includes(value.action)
      && new Set(value.orderIds).size !== value.orderIds.length
    ) {
      context.addIssue({ code: 'custom', path: ['orderIds'], message: 'Order IDs must be unique.' })
    }
})
