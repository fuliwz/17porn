import { createApp } from 'vue'
import App from './App.vue'
import { installEncryptedApiFetchInterceptor } from './api'
import './style.css'

// Install before the remote HTML is written into the document so its
// existing fetch('/api.php?...') calls transparently receive decoded JSON.
installEncryptedApiFetchInterceptor()

createApp(App).mount('#app')
