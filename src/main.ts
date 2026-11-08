import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'
import './mobile.css'
import './security-ui.css'
import './theme.css'
import { initializeTheme } from './appearance'

initializeTheme()
createApp(App).mount('#app')
