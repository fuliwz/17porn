/**
 * API response decoder for the XXVOD PHP backend.
 * Supports legacy AES-GCM v1 and compressed AES-GCM v2 envelopes.
 */
const API_SECRET = 'c229dd8891019b086ad8a4ce7fdaca64'
const utf8Decoder = new TextDecoder('utf-8')

function decodeBase64(value) {
  if (typeof value !== 'string' || !value) {
    throw new Error('API 加密响应缺少 Base64 数据。')
  }
  const binary = atob(value.replace(/\\s+/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function importAesKey() {
  if (!globalThis.crypto?.subtle) {
    throw new Error('当前浏览器不支持 Web Crypto，无法解密 API 响应。')
  }
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(API_SECRET)
  )
  return crypto.subtle.importKey(
    'raw',
    digest,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  )
}

async function decompressGzip(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持 Gzip 解压，请升级浏览器。')
  }
  const stream = new Blob([bytes]).stream().pipeThrough(
    new DecompressionStream('gzip')
  )
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * 解密 PHP api.php 返回的 JSON envelope。
 * v1: AES-GCM(JSON)
 * v2: AES-GCM(Gzip(JSON))，只有压缩后更小时才压缩。
 */
export async function decodeApiResponse(envelope) {
  if (!envelope || Number(envelope.encrypted) !== 1) {
    throw new Error(envelope?.msg || envelope?.error || 'API 返回格式无效。')
  }

  const version = Number(envelope.version || 1)
  if (version !== 1 && version !== 2) {
    throw new Error(`不支持的 API 加密版本：${version}`)
  }

  const iv = decodeBase64(envelope.iv)
  const ciphertext = decodeBase64(envelope.data)
  const tag = decodeBase64(envelope.tag)

  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error('API 加密参数长度无效。')
  }

  const key = await importAesKey()
  // Web Crypto 的 AES-GCM 输入格式为 ciphertext + authentication tag。
  const combined = new Uint8Array(ciphertext.length + tag.length)
  combined.set(ciphertext)
  combined.set(tag, ciphertext.length)

  let plaintext
  try {
    plaintext = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      key,
      combined
    ))
  } catch {
    throw new Error('API 响应解密失败，请检查前后端密钥是否一致。')
  }

  if (version === 2 && envelope.compression === 'gzip') {
    plaintext = await decompressGzip(plaintext)
  } else if (version === 2 && envelope.compression !== 'none') {
    throw new Error(`不支持的 API 压缩格式：${envelope.compression}`)
  }

  let payload
  try {
    payload = JSON.parse(utf8Decoder.decode(plaintext))
  } catch {
    throw new Error('API 解密成功，但 JSON 数据格式无效。')
  }

  if (!payload || typeof payload !== 'object' || !('code' in payload)) {
    throw new Error('API 数据结构不符合预期。')
  }
  return payload
}

/**
 * 请求并解码一个 API。
 * 示例：fetchApi('/api.php', { action: 'vod', ac: 'list', pg: 1 })
 */
export async function fetchApi(apiBase, params = {}, options = {}) {
  const url = new URL(apiBase, window.location.href)
  const query = params instanceof URLSearchParams
    ? params
    : new URLSearchParams(params)

  query.forEach((value, key) => url.searchParams.set(key, value))

  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'omit',
    cache: options.cache || 'default',
    signal: options.signal
  })

  const raw = await response.text()
  if (!response.ok) {
    throw new Error(`API 请求失败：HTTP ${response.status}`)
  }

  let envelope
  try {
    envelope = JSON.parse(raw)
  } catch {
    throw new Error('API 返回了无效 JSON。')
  }
  return decodeApiResponse(envelope)
}
