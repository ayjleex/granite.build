/**
 * The route seam's pure half: the default link builders, and the invariant that
 * ui-core holds exactly one copy of each URL shape.
 *
 * Usage: node --test tests/route-seam.test.js
 *
 * Verification for this seam was previously a manual grep of the built bundle for
 * route strings. That could show the standalone shape was still emitted, but not
 * that the builders produce it correctly, and not that nothing else in ui-core
 * spells the same URL out by hand — which review found it did, in ClientShell's
 * deep-link redirect.
 *
 * These are deliberately node:test checks against the pure module rather than
 * component tests: `config/routeShapes.ts` carries no 'use client' and no React,
 * so it needs no harness, and this workspace has none. Asserting that a mounted
 * provider actually overrides BuildsTable's click target does need one, and is
 * consciously not covered here.
 */

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const UI_CORE_ROOT = path.join(__dirname, '..', '..', '..', 'packages', 'ui-core')

function read(rel) {
  return fs.readFileSync(path.join(UI_CORE_ROOT, rel), 'utf8')
}

/**
 * Evaluate the two default builders out of the TypeScript source.
 *
 * The workspace has no TS loader for node:test, and the builders are two template
 * literals, so extracting and evaluating them is both sufficient and honest about
 * what it covers. It fails loudly if the shape of the declaration changes.
 */
function defaultRoutes() {
  const src = read('config/routeShapes.ts')
  const match = src.match(/export const DEFAULT_ROUTES: AppRoutes = \{([\s\S]*?)\n\}/)
  assert.ok(match, 'could not find DEFAULT_ROUTES in config/routeShapes.ts')
  const body = match[1].replace(/\(buildId\)|\(artifactId\)/g, (m) => m)
  // eslint-disable-next-line no-new-func
  return new Function(`return {${body}}`)()
}

describe('DEFAULT_ROUTES', () => {
  it('produces the standalone query-param scheme', () => {
    const routes = defaultRoutes()
    assert.equal(
      routes.buildHref('abc-123'),
      '/dashboard/builds/_/?id=abc-123',
      'build link shape changed — standalone depends on this exact form',
    )
    assert.equal(
      routes.artifactHref('def-456'),
      '/dashboard/artifacts/_/?id=def-456',
      'artifact link shape changed — standalone depends on this exact form',
    )
  })

  it('percent-encodes ids, so a delimiter cannot truncate the query string', () => {
    const routes = defaultRoutes()
    // `searchParams.get('id')` on the consumer returns only the text before an
    // unencoded `&`, and a bare `+` decodes to a space.
    assert.equal(routes.buildHref('a&b=c').endsWith('?id=a%26b%3Dc'), true)
    assert.equal(routes.buildHref('a+b').endsWith('?id=a%2Bb'), true)
    assert.equal(routes.buildHref('a b').endsWith('?id=a%20b'), true)
    assert.equal(routes.artifactHref('x#y').endsWith('?id=x%23y'), true)
  })

  it('leaves a UUID untouched, so existing links are unchanged', () => {
    const uuid = 'f6e5b23d-fb58-469d-b2a5-c9c661962587'
    const routes = defaultRoutes()
    assert.equal(routes.buildHref(uuid), `/dashboard/builds/_/?id=${uuid}`)
    assert.equal(routes.artifactHref(uuid), `/dashboard/artifacts/_/?id=${uuid}`)
  })
})

describe('the seam is the only place ui-core spells these URLs', () => {
  // Every ui-core source file, minus the one module allowed to contain the
  // literal shape. A second copy is not a style problem: it silently ignores a
  // consumer's injected scheme, which is the whole point of the seam.
  const ALLOWED = path.join('config', 'routeShapes.ts')

  function walk(dir, acc = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, acc)
      else if (/\.tsx?$/.test(entry.name)) acc.push(full)
    }
    return acc
  }

  it('has no other hardcoded /dashboard/builds/_/?id= or artifacts equivalent', () => {
    const offenders = []
    for (const file of walk(UI_CORE_ROOT)) {
      const rel = path.relative(UI_CORE_ROOT, file)
      if (rel === ALLOWED) continue
      const src = fs.readFileSync(file, 'utf8')
      if (src.includes('/dashboard/builds/_/?id=')) offenders.push(`${rel} (build)`)
      if (src.includes('/dashboard/artifacts/_/?id=')) offenders.push(`${rel} (artifact)`)
    }
    assert.deepEqual(
      offenders,
      [],
      `hardcoded route shape outside ${ALLOWED} — route through useRoutes() instead:\n  ` +
        offenders.join('\n  '),
    )
  })
})
