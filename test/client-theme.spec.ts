import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'vitest'

const clientSource = readFileSync(fileURLToPath(new URL('../src/client/index.tsx', import.meta.url)), 'utf8')

test('memory edit save button uses the Host primary-button color pair', () => {
  assert.match(clientSource, /primaryFill:\s*'var\(--dsw-alias-button-primary-fill/u)
  assert.match(clientSource, /onPrimary:\s*'var\(--dsw-alias-label-primary-foreground/u)
  assert.match(clientSource, /color:\s*colors\.onPrimary,\s*background:\s*colors\.primaryFill/u)
  assert.doesNotMatch(clientSource, /color:\s*'#fff',\s*background:\s*colors\.accent/u)
})
