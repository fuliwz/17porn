<script setup>
import { computed, onMounted, ref } from 'vue'

const UPSTREAM_ORIGIN = 'https://xvv.7e5zbdgbh4rebo1.sbs'

const loading = ref(true)
const error = ref('')
const pageHtml = ref('')
const responseStatus = ref(0)

const currentAddress = computed(() => window.location.pathname + window.location.search + window.location.hash)

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
  pageHtml.value = ''

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
    const remoteBase = UPSTREAM_ORIGIN + '/'
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
    pageHtml.value = decoded
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
    <header class="toolbar">
      <a class="brand" href="/" aria-label="首页">17<span>PORN</span></a>
      <div class="source-state">
        <span class="state-dot" :class="{ active: !loading && !error }"></span>
        <span>{{ loading ? '正在连接' : error ? '连接异常' : '已连接' }}</span>
      </div>
    </header>

    <section v-if="loading" class="status-panel" aria-live="polite">
      <div class="spinner"></div>
      <h1>正在加载页面</h1>
      <p>正在通过远程 POST 获取网页内容并解码。</p>
      <small>{{ currentAddress }}</small>
    </section>

    <section v-else-if="error" class="status-panel error-panel" role="alert">
      <div class="error-mark">!</div>
      <h1>页面加载失败</h1>
      <p>{{ error }}</p>
      <small v-if="responseStatus">HTTP 状态：{{ responseStatus }}</small>
      <button type="button" class="retry-button" @click="retry">重新加载</button>
    </section>

    <section v-else class="remote-content">
      <iframe
        class="remote-frame"
        title="远程网页内容"
        sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerpolicy="strict-origin-when-cross-origin"
        :srcdoc="pageHtml"
      ></iframe>
    </section>

    <footer class="footer">远程页面代理展示</footer>
  </main>
</template>
