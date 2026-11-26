import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import sharp from 'sharp'

function readTestEnvironment() {
  const filePath = resolve(process.cwd(), '.env.performance.local')
  const contents = readFileSync(filePath, 'utf8')
  const values = {}

  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (!match) continue
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
  }

  return values
}

async function telegramRequest(token, method, data = {}) {
  let response
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(15000),
    })
  } catch {
    throw new Error(`Telegram ${method} request failed; check connectivity and test credentials.`)
  }

  const result = await response.json().catch(() => null)
  if (!response.ok || !result?.ok) {
    throw new Error(`Telegram ${method} failed: ${result?.description || `HTTP ${response.status}`}`)
  }
  return result.result
}

async function main() {
  const config = readTestEnvironment()
  const expectedUsername = String(config.TELEGRAM_TEST_BOT_USERNAME || '').replace(/^@/, '').toLowerCase()
  const token = config.TELEGRAM_BOT_TOKEN || ''
  const channelId = config.TELEGRAM_CHANNEL_ID || ''

  if (config.TELEGRAM_TEST_MODE !== '1') {
    throw new Error('Set TELEGRAM_TEST_MODE=1 in .env.performance.local before continuing.')
  }
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token) || !expectedUsername) {
    throw new Error('Set the dedicated test bot username and token in .env.performance.local.')
  }

  const bot = await telegramRequest(token, 'getMe')
  if (String(bot.username || '').toLowerCase() !== expectedUsername) {
    throw new Error('The configured bot token does not match TELEGRAM_TEST_BOT_USERNAME.')
  }

  if (!channelId) {
    const updates = await telegramRequest(token, 'getUpdates')
    const testChannels = [...new Map(
      updates
        .map((update) => update.channel_post?.chat)
        .filter((chat) => chat?.type === 'channel' && !chat.username && /test/i.test(chat.title || ''))
        .map((chat) => [chat.id, chat]),
    ).values()]

    if (!testChannels.length) {
      throw new Error('No private TEST channel update found. Post a text message in the test channel, then rerun this script.')
    }

    console.log('Private test channel ID(s):')
    for (const chat of testChannels) {
      console.log(`${chat.title}: ${chat.id}`)
    }
    console.log('Copy the intended ID into TELEGRAM_CHANNEL_ID, then rerun to send one test PNG.')
    return
  }

  if (!/^-100\d{5,}$/.test(channelId)) {
    throw new Error('TELEGRAM_CHANNEL_ID must be the private channel ID beginning with -100.')
  }

  const channel = await telegramRequest(token, 'getChat', { chat_id: channelId })
  if (channel.type !== 'channel' || channel.username || !/test/i.test(channel.title || '')) {
    throw new Error('The destination must be a private channel with TEST in its title.')
  }

  const membership = await telegramRequest(token, 'getChatMember', {
    chat_id: channelId,
    user_id: bot.id,
  })
  if (!['administrator', 'creator'].includes(membership.status) || membership.can_post_messages !== true) {
    throw new Error('The test bot must be a channel admin with Post Messages permission.')
  }

  const image = await sharp({
    create: {
      width: 64,
      height: 64,
      channels: 3,
      background: { r: 128, g: 72, b: 88 },
    },
  }).png().toBuffer()
  const form = new FormData()
  form.append('chat_id', channelId)
  form.append('photo', new Blob([image], { type: 'image/png' }), 'gv-sarees-test.png')

  let response
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(15000),
    })
  } catch {
    throw new Error('Telegram test photo request failed; check connectivity and test credentials.')
  }

  const result = await response.json().catch(() => null)
  if (!response.ok || !result?.ok) {
    throw new Error(`Telegram test photo failed: ${result?.description || `HTTP ${response.status}`}`)
  }

  console.log(`Verified @${bot.username} uploaded one generated test PNG to private channel "${channel.title}".`)
  console.log(`Telegram test message ID: ${result.result.message_id}`)
}

main().catch((error) => {
  console.error(error.message || 'Telegram test verification failed.')
  process.exitCode = 1
})
