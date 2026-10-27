import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'vitest'

const root = join(import.meta.dirname, '..')

test('declares the DSH 0.2.1 runtime contract', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    peerDependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    dsh?: { client?: { inject?: string[] } }
  }
  const peers = pkg.peerDependencies ?? {}
  const dev = pkg.devDependencies ?? {}
  const dshPeers = Object.entries(peers).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))

  assert.ok(dshPeers.length > 0)
  for (const [name, range] of dshPeers) {
    assert.equal(range, '^0.2.1-rc.2', `${name} peer must target the DSH 0.2.1 contract`)
    assert.equal(dev[name], '0.2.1-rc.2', `${name} development dependency must pin the tested runtime`)
  }
  assert.equal(peers['@deepseek-ai/dsh-client-runtime'], undefined)
  assert.equal(dev['@deepseek-ai/dsh-client-runtime'], undefined)
  assert.equal(peers['@deepseek-ai/dsh-client-ui-slots'], '^0.2.1-rc.2')
  assert.equal(dev['@deepseek-ai/dsh-client-ui-slots'], '0.2.1-rc.2')
  assert.ok(pkg.dsh?.client?.inject?.includes('@deepseek-ai/dsh-client-locale'))
  assert.ok(pkg.dsh?.client?.inject?.includes('@deepseek-ai/dsh-client-ui-settings'))
  assert.ok(!pkg.dsh?.client?.inject?.includes('@deepseek-ai/dsh-client-runtime'))
})

test('does not use removed synchronous Session or Persistence APIs', async () => {
  const source = await readFile(join(root, 'src', 'index.ts'), 'utf8')
  assert.doesNotMatch(source, /session\.events/u)
  assert.doesNotMatch(source, /sessionPersistence['"]?\)?\?\.inspect|sessionPersistence\.inspect/u)
  assert.doesNotMatch(source, /kind:\s*['"]plugin['"]/u)
  assert.match(source, /deriveMessages\(/u)
  assert.match(source, /sessionPersistence[\s\S]*?\.stat\(/u)
  assert.match(source, /'workspace-memory':\s*\{ readonly kind: 'workspace-memory' \}/u)
})
