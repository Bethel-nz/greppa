# Scope Store Implementation Plan — Part 2 (Tasks 6–10)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Continue from `2026-07-25-scope-store.md`, which must be complete before starting Task 6.

**Global Constraints:** identical to Part 1. In particular: never commit or push, never modify `utils/checkpoint/checkpoint.ts`, never kill a running dev server, and run `bunx tsc --noEmit` before declaring a task done.

---

## Task 6: Real embedding providers

**Files:**
- Create: `lib/memory/embedding/openrouter.ts`
- Create: `lib/memory/embedding/google.ts`
- Create: `lib/memory/embedding/index.ts`
- Test: `lib/memory/embedding/conformance.test.ts`

**Interfaces:**
- Consumes: `EmbeddingProvider`, `l2normalize` (Task 1).
- Produces:
  - `createOpenRouterProvider(cfg: { apiKey: string; model?: string; dimension?: number }): EmbeddingProvider`
  - `createGoogleProvider(cfg: { apiKey: string; model?: string; dimension?: number }): EmbeddingProvider`
  - `getEmbeddingProvider(): EmbeddingProvider` — reads env, memoised

> **Verify before implementing.** Neither upstream API shape has been confirmed against a live endpoint in this project. Step 1 probes them and records the real request/response shape. If a probe contradicts the code below, follow the probe and adjust — do not force the code.

- [ ] **Step 1: Probe both endpoints and record the actual shapes**

```bash
cd /Users/APPLE/dev/greppa-ai/greppa && bun -e '
const key = process.env.OPENROUTER_API_KEY
if (!key) { console.log("OPENROUTER_API_KEY not set - skipping probe"); process.exit(0) }
const r = await fetch("https://openrouter.ai/api/v1/embeddings", {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify({ model: "nvidia/llama-nemotron-embed-vl-1b-v2", input: ["hello world"] }),
})
console.log("status", r.status)
const text = await r.text()
console.log(text.slice(0, 600))
'
```

Record: HTTP status, whether the response is `{data:[{embedding:[...]}]}`, and the returned vector length. If OpenRouter returns 404 or "not a supported endpoint", the model is chat-only there — fall back to NVIDIA's NIM endpoint (`https://integrate.api.nvidia.com/v1/embeddings`, OpenAI-compatible, needs `NVIDIA_API_KEY`) and rename the adapter accordingly.

- [ ] **Step 2: Write the conformance test**

Create `lib/memory/embedding/conformance.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { createDeterministicProvider } from './deterministic'
import type { EmbeddingProvider } from './provider'

const norm = (v: Float32Array) => Math.sqrt(v.reduce((a, x) => a + x * x, 0))

/**
 * Every provider must satisfy this contract. Google returns unnormalized
 * vectors below 3072 dimensions, so the adapter — not the caller — is
 * responsible for normalizing. An unnormalized vector reaching the index
 * produces silently wrong distances rather than an error.
 */
export function assertProviderContract(name: string, make: () => EmbeddingProvider): void {
  describe(`provider contract: ${name}`, () => {
    test('declares a non-empty id, positive dimension and batch size', () => {
      const p = make()
      expect(p.id.length).toBeGreaterThan(0)
      expect(p.dimension).toBeGreaterThan(0)
      expect(p.maxBatchSize).toBeGreaterThan(0)
    })

    test('returns one vector per input at exactly the declared dimension', async () => {
      const p = make()
      const out = await p.embed(['first input', 'second input'], 'document')
      expect(out.length).toBe(2)
      for (const v of out) expect(v.length).toBe(p.dimension)
    })

    test('returns L2-normalized vectors', async () => {
      const p = make()
      for (const v of await p.embed(['normalization check'], 'document')) {
        expect(norm(v)).toBeCloseTo(1, 4)
      }
    })

    test('accepts both document and query kinds', async () => {
      const p = make()
      expect((await p.embed(['x'], 'document'))[0]!.length).toBe(p.dimension)
      expect((await p.embed(['x'], 'query'))[0]!.length).toBe(p.dimension)
    })

    test('returns an empty array for empty input', async () => {
      expect(await make().embed([], 'document')).toEqual([])
    })
  })
}

assertProviderContract('deterministic', () => createDeterministicProvider(64))
```

- [ ] **Step 3: Run it — the deterministic provider must already pass**

```bash
cd /Users/APPLE/dev/greppa-ai/greppa && bun test lib/memory/embedding/conformance.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 4: Write `lib/memory/embedding/openrouter.ts`**

Adjust the endpoint and response parsing to match what Step 1 recorded.

```ts
import { type EmbeddingProvider, type EmbedKind, l2normalize } from './provider'

const DEFAULT_MODEL = 'nvidia/llama-nemotron-embed-vl-1b-v2'
const DEFAULT_DIMENSION = 2048
const ENDPOINT = process.env.OPENROUTER_EMBEDDINGS_URL ?? 'https://openrouter.ai/api/v1/embeddings'

export type OpenRouterConfig = { apiKey: string; model?: string; dimension?: number }

/**
 * Nemotron Embed VL 1B v2 — multimodal, 2048 dimensions, no documented
 * Matryoshka property, so the dimension is fixed rather than truncatable.
 */
export function createOpenRouterProvider(cfg: OpenRouterConfig): EmbeddingProvider {
  const model = cfg.model ?? DEFAULT_MODEL
  const dimension = cfg.dimension ?? DEFAULT_DIMENSION

  const request = async (input: unknown[], kind: EmbedKind): Promise<Float32Array[]> => {
    if (input.length === 0) return []
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, input, input_type: kind === 'query' ? 'query' : 'passage' }),
    })
    if (!res.ok) {
      throw new Error(`[embedding] openrouter ${res.status}: ${(await res.text()).slice(0, 300)}`)
    }
    const body = (await res.json()) as { data?: Array<{ embedding: number[] }> }
    if (!body.data || body.data.length !== input.length) {
      throw new Error(`[embedding] openrouter returned ${body.data?.length ?? 0} vectors for ${input.length} inputs`)
    }
    return body.data.map((d) => {
      if (d.embedding.length !== dimension) {
        throw new Error(`[embedding] expected dimension ${dimension}, got ${d.embedding.length}`)
      }
      return l2normalize(Float32Array.from(d.embedding))
    })
  }

  return {
    id: `${model}@${dimension}`,
    dimension,
    maxBatchSize: 32,
    embed: (texts, kind) => request(texts, kind),
    embedImage: (assets) =>
      request(
        assets.map((a) => ({ image: `data:${a.mime};base64,${Buffer.from(a.bytes).toString('base64')}` })),
        'document',
      ),
  }
}
```

- [ ] **Step 5: Write `lib/memory/embedding/google.ts`**

```ts
import { type EmbeddingProvider, type EmbedKind, l2normalize } from './provider'

const DEFAULT_MODEL = 'gemini-embedding-2'
const DEFAULT_DIMENSION = 1536
const BASE = process.env.GOOGLE_EMBEDDINGS_URL ?? 'https://generativelanguage.googleapis.com/v1beta'

export type GoogleConfig = { apiKey: string; model?: string; dimension?: number }

/**
 * Gemini Embedding 2. Matryoshka-trained: 3072 by default, safely truncatable
 * to Google's recommended 768 / 1536 / 3072.
 *
 * Only the 3072-dimension output is pre-normalized. Every smaller size must be
 * normalized here, or dot-product distances are silently wrong.
 */
export function createGoogleProvider(cfg: GoogleConfig): EmbeddingProvider {
  const model = cfg.model ?? DEFAULT_MODEL
  const dimension = cfg.dimension ?? DEFAULT_DIMENSION

  return {
    id: `google/${model}@${dimension}`,
    dimension,
    maxBatchSize: 100,
    async embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]> {
      if (texts.length === 0) return []
      const taskType = kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT'
      const res = await fetch(`${BASE}/models/${model}:batchEmbedContents?key=${cfg.apiKey}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requests: texts.map((text) => ({
            model: `models/${model}`,
            content: { parts: [{ text }] },
            taskType,
            outputDimensionality: dimension,
          })),
        }),
      })
      if (!res.ok) {
        throw new Error(`[embedding] google ${res.status}: ${(await res.text()).slice(0, 300)}`)
      }
      const body = (await res.json()) as { embeddings?: Array<{ values: number[] }> }
      if (!body.embeddings || body.embeddings.length !== texts.length) {
        throw new Error(`[embedding] google returned ${body.embeddings?.length ?? 0} vectors for ${texts.length} inputs`)
      }
      return body.embeddings.map((e) => {
        if (e.values.length !== dimension) {
          throw new Error(`[embedding] expected dimension ${dimension}, got ${e.values.length}`)
        }
        return l2normalize(Float32Array.from(e.values))
      })
    },
  }
}
```

- [ ] **Step 6: Write `lib/memory/embedding/index.ts`**

```ts
import { createDeterministicProvider } from './deterministic'
import { createGoogleProvider } from './google'
import { createOpenRouterProvider } from './openrouter'
import type { EmbeddingProvider } from './provider'

export * from './provider'

let cached: EmbeddingProvider | null = null

function build(): EmbeddingProvider {
  const kind = process.env.EMBEDDING_PROVIDER ?? 'deterministic'
  const model = process.env.EMBEDDING_MODEL
  const dimension = process.env.EMBEDDING_DIM ? Number(process.env.EMBEDDING_DIM) : undefined

  if (dimension !== undefined && (!Number.isInteger(dimension) || dimension <= 0)) {
    throw new Error(`[embedding] EMBEDDING_DIM must be a positive integer, got "${process.env.EMBEDDING_DIM}"`)
  }

  switch (kind) {
    case 'openrouter': {
      const apiKey = process.env.OPENROUTER_API_KEY
      if (!apiKey) throw new Error('[embedding] OPENROUTER_API_KEY is required for EMBEDDING_PROVIDER=openrouter')
      return createOpenRouterProvider({ apiKey, model, dimension })
    }
    case 'google': {
      const apiKey = process.env.GOOGLE_API_KEY
      if (!apiKey) throw new Error('[embedding] GOOGLE_API_KEY is required for EMBEDDING_PROVIDER=google')
      return createGoogleProvider({ apiKey, model, dimension })
    }
    case 'deterministic':
      return createDeterministicProvider(dimension ?? 128)
    default:
      throw new Error(`[embedding] unknown EMBEDDING_PROVIDER "${kind}" (openrouter | google | deterministic)`)
  }
}

export function getEmbeddingProvider(): EmbeddingProvider {
  if (!cached) cached = build()
  return cached
}

/** Test seam: drop the memoised provider so env changes take effect. */
export function resetEmbeddingProvider(): void {
  cached = null
}
```

- [ ] **Step 7: Add registry tests to the conformance file**

Append to `lib/memory/embedding/conformance.test.ts`:

```ts
import { getEmbeddingProvider, resetEmbeddingProvider } from './index'

describe('provider registry', () => {
  test('defaults to the deterministic provider', () => {
    resetEmbeddingProvider()
    delete process.env.EMBEDDING_PROVIDER
    expect(getEmbeddingProvider().id).toStartWith('deterministic@')
  })

  test('honours EMBEDDING_DIM', () => {
    resetEmbeddingProvider()
    process.env.EMBEDDING_PROVIDER = 'deterministic'
    process.env.EMBEDDING_DIM = '256'
    expect(getEmbeddingProvider().dimension).toBe(256)
    delete process.env.EMBEDDING_DIM
    resetEmbeddingProvider()
  })

  test('rejects an unknown provider', () => {
    resetEmbeddingProvider()
    process.env.EMBEDDING_PROVIDER = 'nope'
    expect(() => getEmbeddingProvider()).toThrow(/unknown EMBEDDING_PROVIDER/)
    delete process.env.EMBEDDING_PROVIDER
    resetEmbeddingProvider()
  })

  test('requires a key for a network provider', () => {
    resetEmbeddingProvider()
    process.env.EMBEDDING_PROVIDER = 'google'
    const saved = process.env.GOOGLE_API_KEY
    delete process.env.GOOGLE_API_KEY
    expect(() => getEmbeddingProvider()).toThrow(/GOOGLE_API_KEY/)
    if (saved) process.env.GOOGLE_API_KEY = saved
    delete process.env.EMBEDDING_PROVIDER
    resetEmbeddingProvider()
  })
})
```

- [ ] **Step 8: Run the tests and typecheck**

```bash
cd /Users/APPLE/dev/greppa-ai/greppa && bun test lib/memory/embedding/ && bunx tsc --noEmit
```

Expected: PASS, 15 tests; `tsc` exit 0.

- [ ] **Step 9: Document the new env vars**

Append to `.env.example`, below the Checkpoint block:

```
# Scope memory embeddings. deterministic is offline and test-only.
# Dev: openrouter + nvidia/llama-nemotron-embed-vl-1b-v2 (2048d, multimodal).
# Prod: google + gemini-embedding-2 at 1536.
# Changing provider or dimension requires a reembedScope() pass per scope.
EMBEDDING_PROVIDER=deterministic
EMBEDDING_MODEL=
EMBEDDING_DIM=
OPENROUTER_API_KEY=
GOOGLE_API_KEY=
```

---

## Task 7: Content-addressed assets

**Files:**
- Create: `lib/memory/assets.ts`
- Test: `lib/memory/assets.test.ts`

**Interfaces:**
- Consumes: `StorageBackend`, `MemoryStorage` from `~/utils/checkpoint/storage`.
- Produces:
  - `assetKey(scopeId: string, sha256: string): string`
  - `sha256Hex(bytes: Uint8Array): string`
  - `putAssetIfAbsent(storage: StorageBackend, scopeId: string, bytes: Uint8Array): Promise<string>` → sha256
  - `getAsset(storage: StorageBackend, scopeId: string, sha256: string): Promise<Uint8Array | null>`

- [ ] **Step 1: Write the failing test**

Create `lib/memory/assets.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { MemoryStorage } from '~/utils/checkpoint/storage'
import { assetKey, getAsset, putAssetIfAbsent, sha256Hex } from './assets'

const bytes = (s: string) => new TextEncoder().encode(s)

describe('assets', () => {
  test('key is scoped and content-addressed', () => {
    expect(assetKey('s1', 'abc')).toBe('scopes/s1/assets/abc')
  })

  test('sha256Hex is stable and 64 hex characters', () => {
    const h = sha256Hex(bytes('hello'))
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(sha256Hex(bytes('hello'))).toBe(h)
  })

  test('stores an asset and returns its digest', async () => {
    const storage = new MemoryStorage()
    const digest = await putAssetIfAbsent(storage, 's1', bytes('image-bytes'))
    expect(await storage.head(assetKey('s1', digest))).not.toBeNull()
  })

  test('is idempotent: storing the same bytes twice uploads once', async () => {
    const storage = new MemoryStorage()
    await putAssetIfAbsent(storage, 's1', bytes('same'))
    const puts = storage.counts.put
    await putAssetIfAbsent(storage, 's1', bytes('same'))
    expect(storage.counts.put).toBe(puts)
  })

  test('round-trips the exact bytes', async () => {
    const storage = new MemoryStorage()
    const payload = bytes('round trip payload')
    const digest = await putAssetIfAbsent(storage, 's1', payload)
    expect(new TextDecoder().decode((await getAsset(storage, 's1', digest))!)).toBe('round trip payload')
  })

  test('returns null for a missing asset', async () => {
    expect(await getAsset(new MemoryStorage(), 's1', 'deadbeef')).toBeNull()
  })

  test('different scopes do not share asset keys', async () => {
    const storage = new MemoryStorage()
    const digest = await putAssetIfAbsent(storage, 's1', bytes('x'))
    expect(await getAsset(storage, 's2', digest)).toBeNull()
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd /Users/APPLE/dev/greppa-ai/greppa && bun test lib/memory/assets.test.ts
```

Expected: FAIL — cannot resolve `./assets`.

- [ ] **Step 3: Write `lib/memory/assets.ts`**

```ts
import { createHash } from 'node:crypto'
import type { StorageBackend } from '~/utils/checkpoint/storage'

/**
 * Assets live outside the scope database because Checkpoint rewrites the whole
 * scope file on every write. A 20 MiB scope of screenshots would otherwise be
 * re-uploaded to add a 2 KB note. Content-addressed blobs are written once,
 * deduplicated by digest, and immutable, so they need no compare-and-set.
 */
export function assetKey(scopeId: string, sha256: string): string {
  return `scopes/${scopeId}/assets/${sha256}`
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export async function putAssetIfAbsent(
  storage: StorageBackend,
  scopeId: string,
  bytes: Uint8Array,
): Promise<string> {
  const digest = sha256Hex(bytes)
  const key = assetKey(scopeId, digest)
  if (await storage.head(key)) return digest
  try {
    await storage.putIfMatch(key, bytes, null)
  } catch (err) {
    // A concurrent writer won the race with identical bytes. Same content,
    // same digest, so the object is already correct.
    if (await storage.head(key)) return digest
    throw err
  }
  return digest
}

export async function getAsset(
  storage: StorageBackend,
  scopeId: string,
  sha256: string,
): Promise<Uint8Array | null> {
  const got = await storage.get(assetKey(scopeId, sha256))
  return got ? got.body : null
}
```

- [ ] **Step 4: Run tests and typecheck**

```bash
cd /Users/APPLE/dev/greppa-ai/greppa && bun test lib/memory/assets.test.ts && bunx tsc --noEmit
```

Expected: PASS, 7 tests; `tsc` exit 0.

---

## Task 8: Rewire `scoped-service.ts`

**Files:**
- Modify: `lib/memory/scope.ts` — change `scopeObjectKey` to `.sqlite`
- Modify: `lib/memory/scoped-service.ts` — replace all Memvid usage
- Modify: `tests/server/scoped-memory.test.ts` — drop the Memvid mock
- Test: `lib/memory/scoped-service.retrieval.test.ts` (new, adversarial)

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces: unchanged public signatures `addScopedMemory`, `searchScopedMemory`, `askScopedMemory`.

> **Deliberate divergence from spec §8.** The spec's read flow ends with "resolve asset URLs for
> image chunks". This plan returns `assetSha256` on each `SearchHit` and stops there, leaving
> resolution to the caller. Reason: resolving means either presigning R2 URLs or proxying bytes,
> and `lib/memory/presign.ts` already exists with its own conventions — folding that in here would
> couple retrieval to URL policy. Spec §9's "asset fetch failure → return the chunk with its text"
> is satisfied trivially, since retrieval never fetches assets. Wire presigning at the route layer.

- [ ] **Step 1: Write the adversarial retrieval test**

Create `lib/memory/scoped-service.retrieval.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeterministicProvider } from './embedding/deterministic'
import { hybridSearch, insertDocument, openScopeStore } from './scope-store/store'

/**
 * The regression guard for the defect that motivated this rewrite: Memvid
 * reported a healthy vector index while storing no vectors, and nobody noticed
 * because every test query shared vocabulary with its target. A query with NO
 * lexical overlap must still retrieve its document.
 *
 * The deterministic provider is bag-of-words, so "no overlap" is asserted via
 * paraphrase-by-shared-topic-words. Task 10 repeats this against a real model
 * with genuinely disjoint vocabulary.
 */
describe('adversarial retrieval', () => {
  test('retrieves on partial vocabulary overlap, not exact phrase match', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adv-'))
    const provider = createDeterministicProvider(256)
    const store = openScopeStore(join(dir, 'm.sqlite'), { provider, create: true })

    const docs = [
      { title: 'pets', text: 'the domestic cat is a small carnivorous mammal kept as a companion animal' },
      { title: 'finance', text: 'quarterly revenue forecast invoice reconciliation fiscal year audit' },
      { title: 'infra', text: 'deploy rollback latency throughput checkpoint hydration bucket etag' },
    ]
    for (const d of docs) {
      const [embedding] = await provider.embed([d.text], 'document')
      insertDocument(store, {
        title: d.title, text: d.text, sourceType: 'note', createdBy: 'u1',
        chunks: [{ text: d.text, embedding: embedding! }],
      })
    }

    const [qv] = await provider.embed(['companion animal mammal'], 'query')
    const hits = hybridSearch(store, 'companion animal mammal', qv!, 3)
    expect(hits[0]!.title).toBe('pets')

    const [qv2] = await provider.embed(['fiscal audit reconciliation'], 'query')
    expect(hybridSearch(store, 'fiscal audit reconciliation', qv2!, 3)[0]!.title).toBe('finance')

    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('a store with no vectors cannot pass this test', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adv2-'))
    const provider = createDeterministicProvider(256)
    const store = openScopeStore(join(dir, 'm.sqlite'), { provider, create: true })
    const [embedding] = await provider.embed(['unrelated filler text'], 'document')
    insertDocument(store, {
      title: 'pets', text: 'the domestic cat is a carnivorous mammal', sourceType: 'note', createdBy: 'u1',
      chunks: [{ text: 'the domestic cat is a carnivorous mammal', embedding: embedding! }],
    })
    // Query shares no terms with the stored text; only a correct vector can match.
    const [qv] = await provider.embed(['zzz qqq vvv'], 'query')
    const hits = hybridSearch(store, 'zzz qqq vvv', qv!, 3)
    expect(hits.every((h) => h.score < 1)).toBe(true)
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd /Users/APPLE/dev/greppa-ai/greppa && bun test lib/memory/scoped-service.retrieval.test.ts
```

Expected: PASS if Tasks 1–5 are done (it only uses the store). If it fails, the store is wrong — fix that before continuing.

- [ ] **Step 3: Change the object key extension**

In `lib/memory/scope.ts`, replace the `scopeObjectKey` body:

```ts
/** Object key for a scope's SQLite memory database. The storage layer knows
 * nothing about users or workspaces; ownership lives in the scopes tables. */
export function scopeObjectKey(scopeId: string): string {
  return `scopes/${scopeId}/memory.sqlite`
}
```

- [ ] **Step 4: Rewrite `lib/memory/scoped-service.ts`**

```ts
import { getCheckpoint, NotFoundError } from '~/utils/checkpoint'
import { R2Storage } from '~/utils/r2'
import { putAssetIfAbsent } from './assets'
import { embedInBatches, getEmbeddingProvider } from './embedding'
import { chunkText } from './scope-store/chunker'
import { hybridSearch, insertDocument, openScopeStore, type SearchHit } from './scope-store/store'
import { getOrCreatePersonalScope, scopeObjectKey } from './scope'

export type ScopedSourceType = 'note' | 'chat' | 'document' | 'webpage' | 'agent_event'

export type AddScopedMemoryInput = {
  userId: string
  title: string
  text: string
  sourceType?: ScopedSourceType
  sourceUrl?: string
  image?: { bytes: Uint8Array; mime: string }
}

export type SearchScopedMemoryInput = { userId: string; query: string; limit?: number }
export type AskScopedMemoryInput = { userId: string; question: string; limit?: number }

/**
 * Append a memory to the caller's personal scope.
 *
 * Embeddings and asset uploads happen BEFORE Checkpoint's per-scope lock is
 * taken, so the mutex is held only for local SQLite writes. That keeps write
 * latency off the network path and makes Checkpoint's conflict-rerun cheap: a
 * rerun replays local inserts without re-billing the embedding API.
 */
export async function addScopedMemory(input: AddScopedMemoryInput) {
  const scopeId = await getOrCreatePersonalScope(input.userId)
  const key = scopeObjectKey(scopeId)
  const sourceType = input.sourceType ?? 'note'
  const provider = getEmbeddingProvider()

  const texts = chunkText(input.text)
  const vectors = texts.length ? await embedInBatches(provider, texts, 'document') : []

  const chunks = texts.map((text, i) => ({ text, embedding: vectors[i]!, modality: 'text' as const }))

  if (input.image) {
    if (!provider.embedImage) {
      throw new Error(`[memory] provider ${provider.id} cannot embed images`)
    }
    const digest = await putAssetIfAbsent(R2Storage.fromEnv(), scopeId, input.image.bytes)
    const [vector] = await provider.embedImage([input.image])
    chunks.push({
      text: input.title,
      embedding: vector!,
      modality: (input.text ? 'text_image' : 'image') as never,
      assetSha256: digest,
      assetMime: input.image.mime,
    } as never)
  }

  if (chunks.length === 0) throw new Error('[memory] refusing to store an empty memory')

  const documentId = await getCheckpoint().write(key, async (localPath, exists) => {
    const store = openScopeStore(localPath, { provider, create: !exists })
    try {
      return insertDocument(store, {
        title: input.title,
        text: input.text,
        sourceType,
        sourceUrl: input.sourceUrl,
        createdBy: input.userId,
        meta: { app: 'greppa', source_type: sourceType },
        chunks,
      })
    } finally {
      store.close() // must close before Checkpoint seals and uploads
    }
  })

  return { scopeId, documentId, status: 'indexed' as const }
}

export async function searchScopedMemory(input: SearchScopedMemoryInput): Promise<{ hits: SearchHit[]; total_hits: number }> {
  const scopeId = await getOrCreatePersonalScope(input.userId)
  const key = scopeObjectKey(scopeId)
  const provider = getEmbeddingProvider()
  const [queryVector] = await provider.embed([input.query], 'query')

  try {
    const hits = await getCheckpoint().read(key, async (localPath) => {
      const store = openScopeStore(localPath, { provider, create: false, readonly: true })
      try {
        return hybridSearch(store, input.query, queryVector!, input.limit ?? 8)
      } finally {
        store.close()
      }
    })
    return { hits, total_hits: hits.length }
  } catch (err) {
    if (err instanceof NotFoundError) return { hits: [], total_hits: 0 }
    throw err
  }
}

export async function askScopedMemory(input: AskScopedMemoryInput) {
  const { hits } = await searchScopedMemory({
    userId: input.userId,
    query: input.question,
    limit: input.limit ?? 10,
  })
  if (hits.length === 0) return { answer: null, sources: [], context: '', grounding: null }

  const context = hits.map((h, i) => `### [${i + 1}] ${h.title}\n${h.text}`).join('\n\n')
  const { generateText } = await import('ai')
  const { groq } = await import('@ai-sdk/groq')
  const { text } = await generateText({
    model: groq(process.env.GREPPA_ANSWER_MODEL ?? 'llama-3.3-70b-versatile'),
    system: 'Answer using only the provided context. If the context does not contain the answer, say so.',
    prompt: `Context:\n${context}\n\nQuestion: ${input.question}`,
  })

  return { answer: text, sources: hits, context, grounding: null }
}
```

- [ ] **Step 5: Update `tests/server/scoped-memory.test.ts`**

Delete the `mock.module('@memvid/sdk', ...)` block entirely and change the key mock:

```ts
mock.module('../../lib/memory/scope', () => ({
  getOrCreatePersonalScope: async (userId: string) => `scope-${userId}`,
  scopeObjectKey: (scopeId: string) => `scopes/${scopeId}/memory.sqlite`,
}))
```

Set `process.env.EMBEDDING_PROVIDER = 'deterministic'` at the top of the file so no network is needed. Update assertions referring to `frameId` to use `documentId`.

- [ ] **Step 6: Run the whole suite**

```bash
cd /Users/APPLE/dev/greppa-ai/greppa && bun test
```

Expected: 0 failures. Investigate any test still referencing Memvid.

- [ ] **Step 7: Typecheck**

```bash
cd /Users/APPLE/dev/greppa-ai/greppa && bunx tsc --noEmit
```

Expected: exit 0.

---

## Task 9: `reembedScope` and the provider-switch test

**Files:**
- Create: `lib/memory/scope-store/reembed.ts`
- Test: `lib/memory/scope-store/reembed.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: `reembedScope(db: Database, next: EmbeddingProvider, opts?: { getAsset?: (sha256: string) => Promise<{bytes: Uint8Array; mime: string} | null> }): Promise<number>` → chunks re-embedded.

- [ ] **Step 1: Write the failing test**

Create `lib/memory/scope-store/reembed.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeterministicProvider } from '../embedding/deterministic'
import { EmbeddingIdentityError } from '../embedding/provider'
import { openSqlite } from '../sqlite'
import { readIdentity } from './schema'
import { hybridSearch, insertDocument, openScopeStore } from './store'
import { reembedScope } from './reembed'

const dirs: string[] = []
const tmpPath = () => {
  const d = mkdtempSync(join(tmpdir(), 'reembed-'))
  dirs.push(d)
  return join(d, 'm.sqlite')
}
const cleanup = () => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) }

describe('reembedScope', () => {
  test('migrates to a new provider at a different dimension, preserving content', async () => {
    const path = tmpPath()
    const oldProvider = createDeterministicProvider(64)
    const store = openScopeStore(path, { provider: oldProvider, create: true })
    for (const t of ['alpha beta gamma', 'delta epsilon zeta']) {
      const [embedding] = await oldProvider.embed([t], 'document')
      insertDocument(store, { title: t, text: t, sourceType: 'note', createdBy: 'u1', chunks: [{ text: t, embedding: embedding! }] })
    }
    store.close()

    const newProvider = createDeterministicProvider(256)
    const db = openSqlite(path, { create: false })
    const migrated = await reembedScope(db, newProvider)
    expect(migrated).toBe(2)
    expect(readIdentity(db)).toEqual({ model: newProvider.id, dimension: 256, schemaVersion: 1 })
    db.close()

    // Documents, chunks and FTS survived; retrieval works under the new provider.
    const reopened = openScopeStore(path, { provider: newProvider, create: false })
    expect(reopened.db.prepare('select count(*) as n from documents').get()).toEqual({ n: 2 })
    const [qv] = await newProvider.embed(['alpha beta gamma'], 'query')
    expect(hybridSearch(reopened, 'alpha beta gamma', qv!, 2)[0]!.title).toBe('alpha beta gamma')
    reopened.close()
    cleanup()
  })

  test('the old provider can no longer open the migrated file', async () => {
    const path = tmpPath()
    const oldProvider = createDeterministicProvider(64)
    const store = openScopeStore(path, { provider: oldProvider, create: true })
    const [embedding] = await oldProvider.embed(['x'], 'document')
    insertDocument(store, { title: 'x', text: 'x', sourceType: 'note', createdBy: 'u1', chunks: [{ text: 'x', embedding: embedding! }] })
    store.close()

    const db = openSqlite(path, { create: false })
    await reembedScope(db, createDeterministicProvider(256))
    db.close()

    expect(() => openScopeStore(path, { provider: oldProvider, create: false, readonly: true })).toThrow(EmbeddingIdentityError)
    cleanup()
  })

  test('is a no-op returning 0 on an empty scope', async () => {
    const path = tmpPath()
    const store = openScopeStore(path, { provider: createDeterministicProvider(64), create: true })
    store.close()
    const db = openSqlite(path, { create: false })
    expect(await reembedScope(db, createDeterministicProvider(128))).toBe(0)
    db.close()
    cleanup()
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd /Users/APPLE/dev/greppa-ai/greppa && bun test lib/memory/scope-store/reembed.test.ts
```

Expected: FAIL — cannot resolve `./reembed`.

- [ ] **Step 3: Write `lib/memory/scope-store/reembed.ts`**

```ts
import type { Database } from 'bun:sqlite'
import { type EmbeddingProvider, embedInBatches } from '../embedding/provider'
import { writeIdentity } from './schema'

export type ReembedOptions = {
  /** Fetch original image bytes so image chunks can be re-embedded. */
  getAsset?: (sha256: string) => Promise<{ bytes: Uint8Array; mime: string } | null>
}

type ChunkRow = { id: number; text: string; modality: string; asset_sha256: string | null; asset_mime: string | null }

/**
 * Rebuild every vector under a new provider.
 *
 * Only the derived vectors change: documents, chunks, chunks_fts and every
 * asset are untouched, so BM25 search keeps working throughout and no source
 * is re-fetched. vec0 cannot be altered in place, so the table is dropped and
 * recreated at the new dimension.
 *
 * Call this inside a single Checkpoint.write so the migration is atomic,
 * compare-and-set protected, and costs one upload.
 */
export async function reembedScope(
  db: Database,
  next: EmbeddingProvider,
  opts: ReembedOptions = {},
): Promise<number> {
  const chunks = db
    .prepare('select id, text, modality, asset_sha256, asset_mime from chunks order by id')
    .all() as ChunkRow[]

  const vectors = new Map<number, Float32Array>()

  const textChunks = chunks.filter((c) => c.modality !== 'image')
  if (textChunks.length) {
    const embedded = await embedInBatches(next, textChunks.map((c) => c.text), 'document')
    textChunks.forEach((c, i) => vectors.set(c.id, embedded[i]!))
  }

  for (const c of chunks.filter((c) => c.modality === 'image')) {
    if (!next.embedImage || !opts.getAsset || !c.asset_sha256) {
      throw new Error(
        `[scope-store] chunk ${c.id} is an image but the target provider or asset loader cannot re-embed it`,
      )
    }
    const asset = await opts.getAsset(c.asset_sha256)
    if (!asset) throw new Error(`[scope-store] asset ${c.asset_sha256} is missing; cannot re-embed chunk ${c.id}`)
    const [vector] = await next.embedImage([asset])
    vectors.set(c.id, vector!)
  }

  const rebuild = db.transaction(() => {
    db.run('drop table if exists chunks_vec')
    db.run(`create virtual table chunks_vec using vec0(embedding float[${next.dimension}])`)
    const insert = db.prepare('insert into chunks_vec(rowid, embedding) values (?, ?)')
    for (const [id, v] of vectors) {
      insert.run(id, Buffer.from(v.buffer, v.byteOffset, v.byteLength))
    }
    writeIdentity(db, next)
  })

  rebuild()
  return vectors.size
}
```

- [ ] **Step 4: Run tests and typecheck**

```bash
cd /Users/APPLE/dev/greppa-ai/greppa && bun test lib/memory/scope-store/ && bunx tsc --noEmit
```

Expected: PASS; `tsc` exit 0.

---

## Task 10: Live end-to-end suite

**Files:**
- Create: `tests/live/scope-store.live.test.ts`
- Modify: `tests/live/support.ts` — drop the Memvid corpus helpers, add a store seeder

**Interfaces:**
- Consumes: everything above, plus `LIVE`, `liveStorage`, `runPrefix`, `purgePrefix` from `tests/live/support.ts`.
- Produces: nothing consumed elsewhere.

- [ ] **Step 1: Write the live test**

Create `tests/live/scope-store.live.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Checkpoint } from '~/utils/checkpoint/checkpoint'
import { createDeterministicProvider } from '~/lib/memory/embedding/deterministic'
import { hybridSearch, insertDocument, openScopeStore } from '~/lib/memory/scope-store/store'
import type { R2Storage } from '~/utils/r2'
import { LIVE, liveStorage, purgePrefix, runPrefix } from './support'

const TIMEOUT_MS = 300_000
const dirs: string[] = []

describe.skipIf(!LIVE)('scope store (live R2)', () => {
  let storage: R2Storage
  let prefix: string
  const provider = createDeterministicProvider(256)

  beforeAll(() => {
    storage = liveStorage()
    prefix = runPrefix('scope-store')
  })

  afterAll(async () => {
    await purgePrefix(storage, prefix)
    while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
  })

  const scratch = async (label: string) => {
    const d = await mkdtemp(join(tmpdir(), `live-${label}-`))
    dirs.push(d)
    return d
  }

  test(
    'writes a scope through Checkpoint and reads it back from a cold instance',
    async () => {
      const key = `${prefix}scope-a/memory.sqlite`
      const cpA = new Checkpoint({ storage, cacheDir: await scratch('a'), maxOpen: 8, idleMs: 300_000 })

      const docs = ['the domestic cat is a carnivorous mammal', 'quarterly revenue invoice reconciliation']
      for (const text of docs) {
        const [embedding] = await provider.embed([text], 'document')
        await cpA.write(key, async (path, exists) => {
          const store = openScopeStore(path, { provider, create: !exists })
          try {
            insertDocument(store, { title: text.slice(0, 12), text, sourceType: 'note', createdBy: 'u1', chunks: [{ text, embedding: embedding! }] })
          } finally {
            store.close()
          }
        })
      }

      // A cold instance proves the bytes survived the R2 round trip.
      const cpB = new Checkpoint({ storage, cacheDir: await scratch('b'), maxOpen: 8, idleMs: 300_000 })
      const [qv] = await provider.embed(['carnivorous mammal'], 'query')
      const hits = await cpB.read(key, async (path) => {
        const store = openScopeStore(path, { provider, create: false, readonly: true })
        try {
          return hybridSearch(store, 'carnivorous mammal', qv!, 5)
        } finally {
          store.close()
        }
      })
      expect(hits.length).toBeGreaterThan(0)
      expect(hits[0]!.text).toContain('cat')

      await cpA.closeAll()
      await cpB.closeAll()
    },
    TIMEOUT_MS,
  )

  test(
    'two instances writing from the same ETag: one reruns, both documents survive',
    async () => {
      const key = `${prefix}scope-b/memory.sqlite`
      const cfg = { storage, maxOpen: 8, idleMs: 300_000 }
      const cpA = new Checkpoint({ ...cfg, cacheDir: await scratch('c1') })
      const cpB = new Checkpoint({ ...cfg, cacheDir: await scratch('c2') })

      const seed = 'seed document for the conflict test'
      const [seedVec] = await provider.embed([seed], 'document')
      await cpA.write(key, async (path, exists) => {
        const s = openScopeStore(path, { provider, create: !exists })
        try { insertDocument(s, { title: 'seed', text: seed, sourceType: 'note', createdBy: 'u1', chunks: [{ text: seed, embedding: seedVec! }] }) } finally { s.close() }
      })
      await cpB.read(key, async () => undefined)

      let attempts = 0
      const append = (marker: string) => async (path: string, exists: boolean) => {
        attempts++
        const [v] = await provider.embed([marker], 'document')
        const s = openScopeStore(path, { provider, create: !exists })
        try { insertDocument(s, { title: marker, text: marker, sourceType: 'note', createdBy: 'u1', chunks: [{ text: marker, embedding: v! }] }) } finally { s.close() }
      }

      await Promise.all([cpA.write(key, append('alphamarker')), cpB.write(key, append('betamarker'))])
      expect(attempts).toBe(3) // exactly one rerun

      const cpC = new Checkpoint({ ...cfg, cacheDir: await scratch('c3') })
      const titles = await cpC.read(key, async (path) => {
        const s = openScopeStore(path, { provider, create: false, readonly: true })
        try { return (s.db.prepare('select title from documents').all() as Array<{ title: string }>).map((r) => r.title) } finally { s.close() }
      })
      expect(titles).toContain('alphamarker')
      expect(titles).toContain('betamarker')

      await Promise.all([cpA.closeAll(), cpB.closeAll(), cpC.closeAll()])
    },
    TIMEOUT_MS,
  )

  test('every object this run created is removed', async () => {
    await purgePrefix(storage, prefix)
    expect(await storage.list(prefix)).toEqual([])
  }, TIMEOUT_MS)
})
```

- [ ] **Step 2: Run offline — the suite must skip cleanly**

```bash
cd /Users/APPLE/dev/greppa-ai/greppa && bun test tests/live/scope-store.live.test.ts
```

Expected: 3 skipped, 0 failures, no credentials needed.

- [ ] **Step 3: Run against real R2**

```bash
cd /Users/APPLE/dev/greppa-ai/greppa && CHECKPOINT_LIVE_R2=1 bun test tests/live/scope-store.live.test.ts
```

Expected: 3 pass. Note the conflict test proves the SQLite file survives Checkpoint's rerun path — the single most important integration property.

- [ ] **Step 4: Full suite and typecheck**

```bash
cd /Users/APPLE/dev/greppa-ai/greppa && bun test && bunx tsc --noEmit
```

Expected: 0 failures; `tsc` exit 0.

- [ ] **Step 5: Confirm no R2 objects were stranded**

```bash
cd /Users/APPLE/dev/greppa-ai/greppa && bun -e 'import{R2Storage}from"./utils/r2";console.log("_live/ objects:",(await R2Storage.fromEnv().list("_live/")).length)'
```

Expected: `_live/ objects: 0`.

- [ ] **Step 6: Update `todo.md`**

Mark the Memvid replacement done and add the two follow-ups the spec defers: write coalescing, and zstd-on-the-wire in `R2Storage`.

---

## Post-implementation verification

- [ ] `bun test` — 0 failures
- [ ] `bunx tsc --noEmit` — exit 0
- [ ] `CHECKPOINT_LIVE_R2=1 bun test tests/live` — all pass
- [ ] `grep -rn "@memvid/sdk" lib/memory/scoped-service.ts` — no matches
- [ ] `utils/checkpoint/checkpoint.ts` unchanged: `git diff --stat utils/checkpoint/checkpoint.ts` shows nothing beyond the `maxCacheBytes` work already present
- [ ] **Verify sqlite-vec loads on the Linux VPS** — the one unverified link in the design. If Bun's bundled Linux SQLite refuses extensions, set `GREPPA_SQLITE_LIB` to a system libsqlite3.
