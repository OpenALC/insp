import { copyFileSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const assets = join(root, 'src', 'assets')
const icons = join(root, 'src-tauri', 'icons')
const logoSvg = join(assets, 'insp-logo.svg')
const cli = join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
const manifest = join(assets, `.tauri-icon-manifest-${randomUUID()}.json`)
const adaptiveForeground = join(assets, `.tauri-adaptive-foreground-${randomUUID()}.svg`)
const adaptiveScale = 66 / 108
const adaptiveOffset = (1254 * (1 - adaptiveScale)) / 2
const adaptiveSvg = readFileSync(logoSvg, 'utf8').replace(
  '<g id="logo-art">',
  `<g id="logo-art" transform="translate(${adaptiveOffset} ${adaptiveOffset}) scale(${adaptiveScale})">`,
)
writeFileSync(adaptiveForeground, adaptiveSvg)

const iconManifest = {
  default: logoSvg,
  android_fg: adaptiveForeground,
  bg_color: '#ffffff',
}

function runTauriIcon(args) {
  const result = spawnSync(process.execPath, [cli, 'icon', ...args], {
    cwd: root,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

try {
  writeFileSync(manifest, JSON.stringify(iconManifest))
  runTauriIcon([manifest, '--output', icons])
  runTauriIcon([manifest, '--png', '512', '--output', icons])
  runTauriIcon([manifest, '--png', '1254', '--output', icons])

  const logoPng = join(icons, '1254x1254.png')
  copyFileSync(logoPng, join(assets, 'insp-logo.png'))
  copyFileSync(join(icons, '64x64.png'), join(root, 'public', 'insp-favicon.png'))
  copyFileSync(join(icons, '512x512.png'), join(root, 'platforms', 'harmonyos', 'AppScope', 'resources', 'base', 'media', 'app_icon.png'))

  const generatedAndroid = join(root, 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'res')
  const androidIcons = join(icons, 'android')
  for (const directory of readdirSync(generatedAndroid).filter((name) => name.startsWith('mipmap-'))) {
    const sourceDirectory = join(generatedAndroid, directory)
    const outputDirectory = join(androidIcons, directory)
    mkdirSync(outputDirectory, { recursive: true })
    for (const file of readdirSync(sourceDirectory)) {
      copyFileSync(join(sourceDirectory, file), join(outputDirectory, file))
    }
  }
  for (const directory of ['values']) {
    const sourceDirectory = join(generatedAndroid, directory)
    const outputDirectory = join(androidIcons, directory)
    mkdirSync(outputDirectory, { recursive: true })
    for (const file of readdirSync(sourceDirectory).filter((name) => name === 'ic_launcher_background.xml')) {
      copyFileSync(join(sourceDirectory, file), join(outputDirectory, file))
    }
  }
} finally {
  unlinkSync(manifest)
  unlinkSync(adaptiveForeground)
}
