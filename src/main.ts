import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'
import './security-ui.css'
import './theme.css'
import './mobile.css'
import './todo.css'
import './desktop.css'
import { initializeTheme } from './appearance'

initializeTheme()
createApp(App).mount('#app')
