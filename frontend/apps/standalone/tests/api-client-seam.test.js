/**
 * The host seam on ui-core's API clients: that every client goes through it, and
 * that it does not reshape requests addressing something else.
 *
 * Usage: node --test tests/api-client-seam.test.js
 *
 * ui-core had four module-private `axios.create()` instances — gbserver, analytics,
 * chat and dataProcessing — none of which a host app's own interceptor can reach.
 * That matters beyond configuration: `analytics.ts`'s saved failure-trend routes and
 * `chat.ts`'s session scoping are both guarded server-side by `resolve_identity()`,
 * which falls back to one shared identity when no per-user headers arrive. So an
 * unreached client does not fail loudly, it silently merges every user into one
 * bucket — saved analyses other users can overwrite, and `confirm_action` proposals
 * one user can resolve on another's behalf.
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

  it('calls axios.create() exactly once, inside the factory', () => {
    const offenders = []
    for (const entry of fs.readdirSync(API_DIR)) {
      if (!entry.endsWith('.ts')) continue
      const src = fs.readFileSync(path.join(API_DIR, entry), 'utf8')
      // Ignore prose: only count it where it is actually invoked.
      const calls = (src.match(/^\s*(?:const|let)\s+\w+\s*=\s*axios\.create\(/gm) || []).length
      if (calls > 0 && entry !== 'client.ts') offenders.push(`${entry} (${calls})`)
    }
    assert.deepEqual(
      offenders,
      [],
      'these clients bypass createApiClient(), so no host override reaches them:\n  ' +
        offenders.join('\n  '),
    )
  })

  it('lets only the gbserver client take the host base URL', () => {
    // Headers and the 401 hook are shared because identity is needed everywhere.
    // The base URL is not: a host's replacement is a gbserver path (gb-ui returns
    // `/api/v1-env/{env}`), so applying it to analytics or dataProcessing rewrites
    // `/api/analytics/…` and 404s every request. The default is the safe
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

  it('wires all four clients through createApiClient', () => {
    for (const [file, base] of [
      ['api/gbserver.ts', "'/api/v1'"],
      ['api/analytics.ts', "'/api/analytics'"],
      ['api/chat.ts', "'/api/analytics'"],
      ['api/dataProcessing.ts', "'/api/analytics/data-processing'"],
    ]) {
      const src = read(file)
      assert.match(
        src,
        /createApiClient\(apiBase\(/,
        `${file} does not build its client with createApiClient(apiBase(${base}))`,
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

  it('spreads resolveApiHeaders() into the fetch headers', () => {
    assert.match(
      src,
      /headers: \{\s*\.\.\.\(await resolveApiHeaders\(\)\)/,
      'the /chat/stream fetch does not spread resolveApiHeaders() into its headers, so it ' +
        'arrives unidentified however the host is configured',
    )
  })

  it('keeps Content-Type authoritative over the provider', () => {
    // A provider returning its own Content-Type must not change how the JSON body
    // is read, so the literal has to come after the spread rather than before it.
    const spreadAt = src.indexOf('...(await resolveApiHeaders())')
    const contentTypeAt = src.indexOf("'Content-Type': 'application/json'", spreadAt)
    assert.notEqual(spreadAt, -1, 'no resolveApiHeaders() spread found in chat.ts')
    assert.notEqual(contentTypeAt, -1, "no Content-Type literal after the spread")
    assert.ok(
      spreadAt < contentTypeAt,
      'Content-Type must be set after the provider spread, not before it',
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
