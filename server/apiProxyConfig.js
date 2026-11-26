const apiProxyPaths = [
  '/api/admin/products',
  '/api/admin/inventory',
  '/api/admin/reservations',
  '/api/admin/orders',
  '/api/admin/settings',
  '/api/best-sellers',
  '/api/reservations/create',
  '/api/reservations/status',
  '/api/razorpay/create-order',
  '/api/razorpay/verify',
  '/api/razorpay/webhook',
  '/api/test',
]

export function createApiProxyConfig(target) {
  return Object.fromEntries(apiProxyPaths.map((path) => [
    path,
    { target, changeOrigin: true },
  ]))
}
