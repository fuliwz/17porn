<script setup>
import { onMounted, ref } from 'vue'

const UPSTREAM_ORIGIN = 'https://xvv.7e5zbdgbh4rebo1.sbs'

const loading = ref(true)
const error = ref('')
const responseStatus = ref(0)

function base64ToBytes(value) {
  const normalized = value.replace(/\s+/g, '')
  const binary = atob(normalized)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

async function decodeBase64Payload(value) {
  const bytes = base64ToBytes(value)

  // PHP config.php 的 POST 协议：Gzip 压缩后再 Base64。
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('当前浏览器不支持 Gzip 解压，请升级浏览器。')
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
    return await new Response(stream).text()
  }

  // 兼容“Base64 直接编码 UTF-8 HTML”的旧接口格式。
  return new TextDecoder('utf-8').decode(bytes)
}

function extractEncodedHtml(text, contentType) {
  const trimmed = text.trim()

  // 兼容 JSON: { encodedHtml: "..." }。
  if (contentType.includes('application/json') || trimmed.startsWith('{')) {
    try {
      const payload = JSON.parse(trimmed)
      if (typeof payload.encodedHtml === 'string') return payload.encodedHtml
      if (typeof payload.data === 'string') return payload.data
      if (payload.error) throw new Error(String(payload.error))
      throw new Error('JSON 响应中没有 encodedHtml 字段。')
    } catch (e) {
      if (e instanceof SyntaxError) throw new Error('服务器返回了无法解析的 JSON。')
      throw e
    }
  }

  // config.php 的 POST 响应为纯 Base64 文本。
  return trimmed
}

async function loadRemotePage() {
  loading.value = true
  error.value = ''

  const sourceUrl = new URL(window.location.href)
  const targetUrl = new URL(sourceUrl.pathname + sourceUrl.search, UPSTREAM_ORIGIN)

  try {
    const response = await fetch(targetUrl.href, {
      method: 'POST',
      mode: 'cors',
      redirect: 'follow',
      cache: 'no-store',
      headers: {
        'Accept': 'text/plain, application/json, */*'
      },
      body: ''
    })

    responseStatus.value = response.status

    if (!response.ok) {
      throw new Error(`远程服务器返回 HTTP ${response.status}`)
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase()
    const responseText = await response.text()

    if (!responseText.trim()) {
      throw new Error('远程服务器返回空内容。')
    }

    const encoded = extractEncodedHtml(responseText, contentType)
    let decoded = await decodeBase64Payload(encoded)

    if (!decoded.trim()) {
      throw new Error('解码后的网页内容为空。')
    }

    // Make root-relative and relative assets resolve against the remote site, not the Pages host.
    const remoteBase = targetUrl.origin + targetUrl.pathname
    const baseTag = '<base href="' + remoteBase.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '">'
    if (/<head\b[^>]*>/i.test(decoded)) {
      if (/<base\b[^>]*>/i.test(decoded)) {
        decoded = decoded.replace(/<base\b[^>]*>/i, baseTag)
      } else {
        decoded = decoded.replace(/<head\b[^>]*>/i, match => match + baseTag)
      }
    } else {
      decoded = baseTag + decoded
    }
    // 将解码后的完整 HTML 写入当前页面，不使用 iframe。
    document.open()
    document.write(decoded)
    document.close()
  } catch (e) {
    console.error('Remote POST load failed:', e)
    if (e instanceof TypeError && /fetch|network|failed/i.test(e.message)) {
      error.value = '远程请求失败。请检查目标站是否允许当前前端域名跨域 POST（CORS），以及 HTTPS 证书和网络连接。'
    } else {
      error.value = e?.message || '加载失败，请稍后重试。'
    }
  } finally {
    loading.value = false
  }
}

function retry() {
  loadRemotePage()
}

onMounted(loadRemotePage)
</script>

<template>
  <main class="shell">
    <section v-if="loading" class="loading-screen" aria-live="polite">
      <div class="loading-spinner"></div>
      <div class="loading-text">网页正在加载中<span class="loading-dots">....</span></div>
    </section>

    <section v-else-if="error" class="error-screen" role="alert">
      <div class="error-mark">!</div>
      <h1>页面加载失败</h1>
      <p>{{ error }}</p>
      <small v-if="responseStatus">HTTP 状态：{{ responseStatus }}</small>
      <button type="button" class="retry-button" @click="retry">重新加载</button>
    </section>
  </main>
</template>
