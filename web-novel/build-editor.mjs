import { build } from 'esbuild'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const output = join(root, 'public', 'editor.bundle.mjs')
const bundled = await build({
  absWorkingDir: root, entryPoints: ['editor/codemirror.mjs'], outfile: output,
  bundle: true, format: 'esm', platform: 'browser', target: ['es2022'],
  minify: true, legalComments: 'eof', metafile: true, write: false,
})
const modules = new Set()
for (const input of Object.keys(bundled.metafile.inputs)) {
  const match = /^node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(input)
  if (match) modules.add(match[1])
}
const notices = []
for (const name of [...modules].sort()) {
  const path = join(root, 'node_modules', name)
  const { version, license } = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'))
  const files = (await readdir(path)).filter(file => /^(?:LICENSE|COPYING|NOTICE)(?:\..*)?$/i.test(file)).sort()
  if (!files.length) throw new Error('Missing license for ' + name)
  const texts = await Promise.all(files.map(file => readFile(join(path, file), 'utf8')))
  notices.push(name + ' ' + version + ' (' + license + ')\n\n' + texts.join('\n\n'))
}
await mkdir(dirname(output), { recursive: true })
await writeFile(join(root, 'public', 'editor.notices.txt'), notices.join('\n\n----------------\n\n'), 'utf8')
await writeFile(output, bundled.outputFiles[0].contents)
