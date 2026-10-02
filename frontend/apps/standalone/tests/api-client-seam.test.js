/**
 * The host seam on ui-core's API clients: that every client goes through it, and
 * that it does not reshape requests addressing something else.
 *
 * Usage: node --test tests/api-client-seam.test.js
 *
 * ui-core had four module-private `axios.create()` instances — gbserver, analytics,
 * chat and dataProcessing — none of which a host app's own interceptor can reach.
 * An unreached client does not fail loudly: identity-scoped routes fall back to one
 * shared identity, silently merging every user into one bucket. See
 * `ApiClientOverrides` in api/client.ts for the detail.
 *
 * `createApiClient()` in api/client.ts is the single seam. The checks here are the
 * two things that go wrong:
 *
 *   1. A client that bypasses the factory. That is how the original four got here,
 *      and a fifth added later would inherit the same bug invisibly.
 *   2. The factory reshaping a request that opted out. `getBuildStepLog` passes
 *      `baseURL: ''` so gbserver's `log_path` is used verbatim; applying the host's
 *      prefix breaks the URL and applying its bearer token sends credentials to
 *      whatever origin `log_path` names.
 *
 * These are static source checks by necessity, not preference: this workspace's
 * harness is plain `node --test` with no DOM and no TypeScript transpiler, so an
 * axios interceptor and a native `fetch` cannot be exercised here. They verify
 * shape, not behaviour — a wrong `.set()` call would pass. The failure mode worth
 * guarding is structural anyway, and CI's `frontend` job plus `tsc` cover the rest.
 */

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const UI_CORE_ROOT = path.join(__dirname, '..', '..', '..', 'packages', 'ui-core')
const API_DIR = path.join(UI_CORE_ROOT, 'api')

function read(rel) {
  return fs.readFileSync(path.join(UI_CORE_ROOT, rel), 'utf8')
}

/** Every .ts/.tsx file in the package, skipping build and dependency output. */
function tsFilesUnder(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
      continue
    }
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...tsFilesUnder(full))
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

/**
 * The source of the balanced (...) argument list following `marker`.
 *
 * Scoping matters more than it looks. A whole-file regex for
 * `use(async (config) => { ... resolveApiHeaders()` passes as long as the call
 * appears *anywhere* later in the file — including in an unrelated path — so it
 * still passes against an interceptor whose body has been gutted. Matching only
 * within the call's own parentheses is what makes the check mean what it says.
 */
function callArgumentSource(src, marker) {
  const start = src.indexOf(marker)
  if (start === -1) return ''
  let i = src.indexOf('(', start + marker.length - 1)
  if (i === -1) return ''
  let depth = 0
  const from = i
  for (; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1
    else if (src[i] === ')') {
      depth -= 1
      if (depth === 0) return src.slice(from, i + 1)
    }
  }
  return ''
}

describe('every ui-core API client goes through the seam', () => {
  it('api/ is where these checks expect it', () => {
    // So that a moved or renamed file fails loudly here instead of making every
    // "source contains ..." check below pass vacuously against an empty string.
    assert.ok(fs.existsSync(API_DIR), `packages/ui-core/api not found at ${API_DIR}`)
    assert.ok(read('api/client.ts').length > 500, 'api/client.ts unexpectedly small — wrong file?')
  })

  it('gives only client.ts the ability to construct an axios instance', () => {
    // Checked by import, not by call shape. An earlier version of this test
    // matched `const x = axios.create(` at the start of a line, which a client
    // written as `export const x = axios.create(` walks straight past. A module
    // that cannot name the default axios binding cannot construct an instance at
    // all, however the call is written. A named import is fine: analytics.ts
    // takes `{ AxiosError }` only, for instanceof checks.
    //
    // Four ways a module can get its hands on a constructor, all covered: a
    // default import, a namespace import, `{ default as … }`, and the named
    // `Axios` class via `new Axios(...)`. The whole package is scanned, not just
    // api/ — nothing outside it touches axios today, which is the point worth
    // keeping true.
    const offenders = []
    for (const file of tsFilesUnder(UI_CORE_ROOT)) {
      const rel = path.relative(UI_CORE_ROOT, file)
      if (rel === path.join('api', 'client.ts')) continue
      const src = fs.readFileSync(file, 'utf8')

      for (const [, clause] of src.matchAll(
        /\bimport\s+([\s\S]*?)\s+from\s*['"]axios['"]/g,
      )) {
        const c = clause.trim()
        const named = c.match(/^\{([\s\S]*)\}$/)
        if (named) {
          // `{ AxiosError }` is fine — a type/value import that constructs
          // nothing. `{ default as x }` is a default import wearing a disguise.
          if (/\bdefault\s+as\b/.test(named[1])) offenders.push(`${rel} (default as)`)
          continue
        }
        if (c.startsWith('*')) offenders.push(`${rel} (namespace import)`)
        else if (/^(?!type\b)[A-Za-z_$][\w$]*/.test(c)) offenders.push(`${rel} (default import)`)
      }

      if (/\bnew\s+Axios\s*\(/.test(src)) offenders.push(`${rel} (new Axios())`)
    }
    assert.deepEqual(
      offenders,
      [],
      'these modules can construct an axios instance that no host override ' +
        'reaches; route them through createApiClient():\n  ' +
        offenders.join('\n  '),
    )
  })

  it('calls axios.create() exactly once in client.ts', () => {
    // The companion to the check above, and the half the old test name claimed
    // but never did: it counted calls outside client.ts and never inside it, so
    // a second instance added next to the factory passed.
    // Comments are stripped so the prose mentions of `axios.create()` in the
    // TSDoc are not counted. Line comments are cut at the `//` rather than
    // taking the whole line with them: a trailing comment on the real call
    // would otherwise drop it and report zero.
    const src = read('api/client.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => {
        const at = line.indexOf('//')
        return at === -1 ? line : line.slice(0, at)
      })
      .join('\n')
    const calls = (src.match(/axios\.create\(/g) || []).length
    assert.equal(calls, 1, `expected one axios.create() in api/client.ts, found ${calls}`)
  })

  it('lets only the gbserver client take the host base URL', () => {
    // Headers and the 401 hook are shared because identity is needed everywhere.
    // The base URL is not: a replacement pointing at a different gbserver would
    // rewrite `/api/analytics/…` and 404 every request. The default is the safe
    // direction, and this asserts nothing has quietly opted in.
    const optedIn = []
    for (const entry of fs.readdirSync(API_DIR)) {
      if (!entry.endsWith('.ts') || entry === 'client.ts') continue
      const src = fs.readFileSync(path.join(API_DIR, entry), 'utf8')
      if (/allowHostBaseUrl:\s*true/.test(src)) optedIn.push(entry)
    }
    assert.deepEqual(
      optedIn,
      ['gbserver.ts'],
      'only api/gbserver.ts may pass allowHostBaseUrl: true — got: ' + optedIn.join(', '),
    )
  })

  it('wires all four clients through createApiClient, on their own paths', () => {
    for (const [file, base] of [
      ['api/gbserver.ts', '/api/v1'],
      ['api/analytics.ts', '/api/analytics'],
      ['api/chat.ts', '/api/analytics'],
      ['api/dataProcessing.ts', '/api/analytics/data-processing'],
    ]) {
      // The path is asserted, not just mentioned in the failure message. Without
      // it this only restated the previous check, and a client silently moved to
      // another base URL still passed.
      const expected = new RegExp(
        'createApiClient\\(\\s*apiBase\\(\\s*[\'"]' +
          base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
          '[\'"]\\s*\\)',
      )
      assert.match(
        read(file),
        expected,
        `${file} does not build its client with createApiClient(apiBase('${base}'))`,
      )
    }
  })
})

describe('the seam only reshapes requests that did not opt out', () => {
  const src = read('api/client.ts')

  it('bails out of the request interceptor for a non-default baseURL', () => {
    const body = callArgumentSource(src, 'instance.interceptors.request.use')
    assert.ok(body.length > 0, 'could not parse the request interceptor — has its shape changed?')
    assert.match(
      body,
      /config\.baseURL !== baseURL\)?\s*return config/,
      'the interceptor must leave a request that sets its own baseURL alone — otherwise the ' +
        "host prefix and bearer token are applied to it",
    )
    const guardAt = body.search(/config\.baseURL !== baseURL/)
    const overridesAt = body.search(/resolveBaseUrl|resolveApiHeaders/)
    assert.ok(guardAt !== -1 && overridesAt !== -1, 'expected both the guard and the overrides')
    assert.ok(guardAt < overridesAt, 'the baseURL guard must precede applying any override')
  })

  it('gates the base-URL override on the client opting in', () => {
    // The call-site check above is only half of it: if the factory stops honouring
    // the flag, every client takes the host's gbserver base again and the opt-in
    // becomes decoration. Found by reverting exactly that and watching the suite
    // stay green.
    const body = callArgumentSource(src, 'instance.interceptors.request.use')
    assert.match(
      body,
      /options\.allowHostBaseUrl\s*&&\s*resolveBaseUrl/,
      'the factory must apply resolveBaseUrl only when the client passed ' +
        'allowHostBaseUrl, or analytics and dataProcessing get rewritten to a gbserver path',
    )
  })

  it('keeps getBuildStepLog opting out of the base URL', () => {
    // The guard is only load-bearing because this call site exists. If it stops
    // passing `baseURL: ''`, log_path starts resolving against the API base.
    const fn = read('api/gbserver.ts')
    const at = fn.indexOf('export async function getBuildStepLog')
    assert.notEqual(at, -1, 'getBuildStepLog not found')
    const body = fn.slice(at, fn.indexOf('\n}', at))
    assert.match(
      body,
      /baseURL:\s*''/,
      "getBuildStepLog must pass baseURL: '' so gbserver's log_path is used verbatim",
    )
  })

  it('decides ownership on the request and reads it back on the response', () => {
    // The response side cannot re-derive this from baseURL: by then the request
    // interceptor has replaced it with the host's prefix, so comparing against the
    // client's default there would treat every real 401 as foreign and never call
    // onUnauthorized. Guarded because that mistake type-checks cleanly.
    assert.match(src, /const OWNED_REQUEST = /, 'expected a tag recording request ownership')
    const response = callArgumentSource(src, 'instance.interceptors.response.use')
    assert.ok(response.length > 0, 'could not parse the response interceptor')
    assert.match(
      response,
      /OWNED_REQUEST\]/,
      'the 401 handler must gate on the ownership tag, not on baseURL',
    )
    assert.doesNotMatch(
      response,
      /baseURL !== baseURL|baseURL === baseURL|baseURL !== DEFAULT|baseURL === DEFAULT/,
      'the response side must not compare baseURL — it has already been rewritten',
    )
  })
})

describe('the streaming path carries headers too', () => {
  // /chat/stream uses native fetch because axios does not stream cleanly
  // in-browser, so it is the one request that cannot go through an interceptor
  // and has to spread the headers itself. A new fetch-based route added later
  // forgetting this is the regression worth catching.
  const src = read('api/chat.ts')

  it('builds its fetch headers from resolveApiHeaders()', () => {
    assert.match(
      src,
      /new Headers\(await resolveApiHeaders\(\)\)/,
      'the /chat/stream fetch does not seed its headers from resolveApiHeaders(), so it ' +
        'arrives unidentified however the host is configured',
    )
  })

  it('keeps Content-Type authoritative over the provider, in any casing', () => {
    // A provider returning its own Content-Type must not change how the JSON body
    // is read, so it is set after the provider's headers are in.
    const seedAt = src.indexOf('new Headers(await resolveApiHeaders())')
    assert.notEqual(seedAt, -1, 'no resolveApiHeaders() seed found in chat.ts')
    const setAt = src.indexOf(".set('Content-Type', 'application/json')", seedAt)
    assert.notEqual(setAt, -1, 'no Content-Type set() after the provider headers')
    assert.ok(seedAt < setAt, 'Content-Type must be set after the provider headers, not before')

    // And it must go through Headers.set, which is case-insensitive. An object
    // literal keyed 'Content-Type' does not overwrite a provider's lowercase
    // 'content-type': both survive as distinct keys and fetch joins them into
    // one comma-separated value, which the server reads from the front. So
    // ordering alone is not enough, and a literal here is the regression.
    assert.doesNotMatch(
      src,
      /headers:\s*\{\s*\.\.\.\(await resolveApiHeaders\(\)\)/,
      'chat.ts spreads the provider into an object literal — a lowercase ' +
        "'content-type' from a provider would survive alongside 'Content-Type'; " +
        'seed a Headers object and call .set() instead',
    )
  })

  it('uses exactly one fetch, so no second streaming path escaped the rule', () => {
    const fetches = (src.match(/\bfetch\(/g) || []).length
    assert.equal(
      fetches,
      1,
      `chat.ts makes ${fetches} fetch() calls — each one needs the header spread above`,
    )
  })
})

describe('the header provider degrades rather than failing the call', () => {
  const src = read('api/client.ts')

  it('swallows a throwing or rejecting provider', () => {
    const at = src.indexOf('export async function resolveApiHeaders')
    assert.notEqual(at, -1, 'resolveApiHeaders not found in client.ts')
    const body = src.slice(at, src.indexOf('\n}', at))
    assert.match(
      body,
      /try \{[\s\S]*catch[\s\S]*return \{\}/,
      'a provider that throws must contribute no headers rather than taking the widget down — ' +
        'that degrades to the same unidentified behaviour as having no provider',
    )
  })

  it('awaits the provider, so a token refresh works', () => {
    assert.match(
      src,
      /await resolveHeaders\(\)/,
      'resolveHeaders must be awaited, or an async provider contributes a Promise as a header',
    )
  })
})
