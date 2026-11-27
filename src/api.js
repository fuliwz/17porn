/**
 * XXVOD API decoder.
 * v1: AES-256-GCM(JSON)
 * v2: AES-256-GCM(Gzip(JSON))
 *
 * The PHP API currently emits v1. v2 is supported for the compressed
 * backend protocol when that backend update is deployed.
 */
const API_SECRET = 'c229dd8891019b086ad8a4ce7fdaca64'
const decoder = new TextDecoder('utf-8')
let importedKeyPromise

function decodeBase64(value, fieldName) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`API 加密响应缺少 ${fieldName}。`)
  }
  const normalized = value.replace(/\s+/g, '')
  let binary
  try {
    binary = atob(normalized)
  } catch {
    throw new Error(`API 加密字段 ${fieldName} 不是有效的 Base64。`)
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function getAesKey() {
  if (!globalThis.crypto?.subtle) {
    throw new Error('当前浏览器不支持 Web Crypto，无法解密 API 响应。')
  }
  if (!importedKeyPromise) {
    importedKeyPromise = crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(API_SECRET)
    ).then(hash => crypto.subtle.importKey(
      'raw',
      hash,
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    ))
  }
  return importedKeyPromise
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

export async function decodeApiResponse(envelope) {
  if (!envelope || Number(envelope.encrypted) !== 1) {
    throw new Error(envelope?.msg || envelope?.error || 'API 加密响应格式无效。')
  }

  const version = Number(envelope.version || 1)
  if (version !== 1 && version !== 2) {
    throw new Error(`不支持的 API 加密版本：${version}`)
  }

  const iv = decodeBase64(envelope.iv, 'iv')
  const ciphertext = decodeBase64(envelope.data, 'data')
  const tag = decodeBase64(envelope.tag, 'tag')
  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error('API 加密参数长度无效。')
  }

  const combined = new Uint8Array(ciphertext.length + tag.length)
  combined.set(ciphertext)
  combined.set(tag, ciphertext.length)

  let plaintext
  try {
    plaintext = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      await getAesKey(),
      combined
    ))
  } catch {
    throw new Error('API 响应解密失败，请检查前后端密钥是否一致。')
  }

  if (version === 2) {
    const compression = envelope.compression || 'none'
    if (compression === 'gzip') {
      plaintext = await decompressGzip(plaintext)
    } else if (compression !== 'none') {
      throw new Error(`不支持的 API 压缩格式：${compression}`)
    }
  }

  let payload
  try {
    payload = JSON.parse(decoder.decode(plaintext))
  } catch {
    throw new Error('API 解密成功，但 JSON 数据格式无效。')
  }

  if (!payload || typeof payload !== 'object' || !('code' in payload)) {
    throw new Error('API 数据结构不符合预期。')
  }
  return payload
}

/**
 * Fetch an API endpoint and return its decoded JSON payload.
 * Example: fetchApi('/api.php', { action: 'vod', ac: 'detail', pg: 1 })
 */
export async function fetchApi(apiBase, params = {}, options = {}) {
  const url = new URL(apiBase, window.location.href)
  const query = params instanceof URLSearchParams
    ? params
    : new URLSearchParams(params)
  query.forEach((value, key) => url.searchParams.set(key, value))

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: { Accept: 'application/json', ...options.headers },
    credentials: options.credentials || 'omit',
    cache: options.cache || 'default',
    signal: options.signal
  })

  if (!response.ok) {
    throw new Error(`API 请求失败：HTTP ${response.status}`)
  }

  let envelope
  try {
    envelope = await response.json()
  } catch {
    throw new Error('API 返回了无效 JSON。')
  }
  return Number(envelope?.encrypted) === 1
    ? decodeApiResponse(envelope)
    : envelope
}

/**
 * Transparently decode encrypted API responses from existing fetch() calls.
 * This is useful for the remotely rendered frontend HTML loaded by App.vue:
 * no changes to each individual API call are needed.
 */
export function installEncryptedApiFetchInterceptor() {
  if (typeof window === 'undefined' || window.__xxvodEncryptedFetchInstalled) {
    return
  }

  const originalFetch = window.fetch.bind(window)
  window.__xxvodEncryptedFetchInstalled = true

  window.fetch = async (...args) => {
    const response = await originalFetch(...args)
    const contentType = response.headers.get('content-type') || ''
    if (!response.ok || !contentType.toLowerCase().includes('json')) {
      return response
    }

    let envelope
    try {
      envelope = await response.clone().json()
    } catch {
      return response
    }

    if (Number(envelope?.encrypted) !== 1) {
      return response
    }

    const payload = await decodeApiResponse(envelope)
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    headers.delete('content-encoding')
    headers.set('content-type', 'application/json; charset=utf-8')

    return new Response(JSON.stringify(payload), {
      status: response.status,
      statusText: response.statusText,
      headers
    })
  }

  // Also expose an explicit client for pages that prefer direct use.
  window.xxvodApi = Object.freeze({ fetchApi, decodeApiResponse })
}
