export default async function handler(req, res) {
  res.setHeader('Allow', 'GET')
  res.setHeader('Cache-Control', 'no-store')
  res.statusCode = 410
  res.setHeader('Content-Type', 'application/json')
  return res.end(JSON.stringify({
    success: false,
    message: 'Customer cancellation is unavailable. Paid orders must be managed by the store.',
  }))
}
