import { cp, mkdir, rm, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const builtWeb = resolve(repositoryRoot, 'dist')
const webResources = resolve(
  repositoryRoot,
  'platforms/harmonyos/entry/src/main/resources/rawfile/web'
)

await stat(resolve(builtWeb, 'index.html'))
await rm(webResources, { recursive: true, force: true })
await mkdir(dirname(webResources), { recursive: true })
await cp(builtWeb, webResources, { recursive: true })
process.stdout.write('Copied frontend dist into the HarmonyOS rawfile bundle.\n')
