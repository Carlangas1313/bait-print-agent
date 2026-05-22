/**
 * Tests para src/renderer/logo-cache.ts
 *
 * Framework: node:test (builtin de Node 22). Lo corremos con `tsx` loader
 * via el script `npm test` del package.json.
 *
 * Estrategia:
 *  - No tocamos $HOME real: el cache_dir es inyectable por test (con la
 *    opcion `cacheDirOverride`). Cada test usa un dir temporal bajo
 *    `os.tmpdir()` que limpia en `after()`.
 *  - Supabase client es un mock minimo con la forma `{ storage: { from() } }`
 *    que retorna un objeto con `createSignedUrl()`. El test controla si
 *    retorna error/data, y cuenta llamadas con un counter.
 *  - Para el fetch del signed URL usamos `globalThis.fetch` interceptado
 *    via stub (guardamos el original en setup() y restauramos en teardown()).
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getLogoPath } from './logo-cache.js';

// ============================================================
// Helpers de mocks
// ============================================================

type MockSupabaseState = {
  createSignedUrlCalls: number;
  createSignedUrlResponse: { data: { signedUrl: string } | null; error: { message: string } | null };
};

function makeMockSupabase(state: MockSupabaseState) {
  return {
    storage: {
      from(_bucket: string) {
        return {
          async createSignedUrl(_path: string, _ttl: number) {
            state.createSignedUrlCalls++;
            return state.createSignedUrlResponse;
          },
        };
      },
    },
  } as never; // cast para evitar arrastrar tipos completos de @supabase/supabase-js en tests
}

let originalFetch: typeof globalThis.fetch;
let fetchCalls: { url: string }[] = [];
let nextFetchResponse: { ok: boolean; status: number; body: Buffer } = {
  ok: true,
  status: 200,
  body: Buffer.from([0x89, 0x50, 0x4e, 0x47]), // PNG magic header (4 bytes)
};

function stubFetch() {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    fetchCalls.push({ url });
    return {
      ok: nextFetchResponse.ok,
      status: nextFetchResponse.status,
      async arrayBuffer() {
        return nextFetchResponse.body.buffer.slice(
          nextFetchResponse.body.byteOffset,
          nextFetchResponse.body.byteOffset + nextFetchResponse.body.byteLength,
        );
      },
    } as Response;
  }) as typeof globalThis.fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
  fetchCalls = [];
  nextFetchResponse = {
    ok: true,
    status: 200,
    body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  };
}

// ============================================================
// Tests
// ============================================================

describe('getLogoPath', () => {
  let tmpDir: string;

  before(() => {
    stubFetch();
  });

  after(() => {
    restoreFetch();
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bait-logo-cache-test-'));
    fetchCalls = [];
  });

  it('retorna null si storagePath es null', async () => {
    const state: MockSupabaseState = {
      createSignedUrlCalls: 0,
      createSignedUrlResponse: { data: null, error: null },
    };
    const result = await getLogoPath(null, 'abc123', makeMockSupabase(state), {
      cacheDirOverride: tmpDir,
    });
    assert.equal(result, null);
    assert.equal(state.createSignedUrlCalls, 0, 'no debe llamar a Supabase si path es null');
  });

  it('retorna null si hash es null aunque path exista', async () => {
    const state: MockSupabaseState = {
      createSignedUrlCalls: 0,
      createSignedUrlResponse: { data: null, error: null },
    };
    const result = await getLogoPath(
      'rid/abc123-thermal.png',
      null,
      makeMockSupabase(state),
      { cacheDirOverride: tmpDir },
    );
    assert.equal(result, null);
    assert.equal(state.createSignedUrlCalls, 0);
  });

  it('cache hit: si el archivo existe local, no llama a Supabase', async () => {
    // Setup: crear el archivo cacheado con el hash esperado.
    const hash = 'deadbeefcafe';
    const cachedFile = path.join(tmpDir, `${hash}.png`);
    fs.writeFileSync(cachedFile, Buffer.from([0xff]));

    const state: MockSupabaseState = {
      createSignedUrlCalls: 0,
      createSignedUrlResponse: { data: null, error: null },
    };

    const result = await getLogoPath(
      'rid/deadbeefcafe-thermal.png',
      hash,
      makeMockSupabase(state),
      { cacheDirOverride: tmpDir },
    );

    assert.equal(result, cachedFile);
    assert.equal(state.createSignedUrlCalls, 0, 'cache hit no debe pegarle a Supabase');
    assert.equal(fetchCalls.length, 0, 'cache hit no debe hacer fetch');
  });

  it('cache miss: genera signed URL + baja + escribe', async () => {
    const hash = 'newhash12345';
    const cachedFile = path.join(tmpDir, `${hash}.png`);
    assert.equal(fs.existsSync(cachedFile), false, 'precondicion: el cache no existe');

    const state: MockSupabaseState = {
      createSignedUrlCalls: 0,
      createSignedUrlResponse: {
        data: { signedUrl: 'https://supabase.example/signed/url' },
        error: null,
      },
    };

    const result = await getLogoPath(
      `rid/${hash}-thermal.png`,
      hash,
      makeMockSupabase(state),
      { cacheDirOverride: tmpDir },
    );

    assert.equal(result, cachedFile);
    assert.equal(state.createSignedUrlCalls, 1);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0]?.url, 'https://supabase.example/signed/url');
    assert.equal(fs.existsSync(cachedFile), true, 'el archivo deberia haberse escrito');
  });

  it('si createSignedUrl falla, tira error', async () => {
    const state: MockSupabaseState = {
      createSignedUrlCalls: 0,
      createSignedUrlResponse: {
        data: null,
        error: { message: 'object not found' },
      },
    };

    await assert.rejects(
      async () =>
        getLogoPath('rid/missing-thermal.png', 'missing00000', makeMockSupabase(state), {
          cacheDirOverride: tmpDir,
        }),
      /signed url failed/i,
    );
  });

  it('si fetch del signed URL falla con !ok, tira error', async () => {
    nextFetchResponse = { ok: false, status: 404, body: Buffer.alloc(0) };

    const state: MockSupabaseState = {
      createSignedUrlCalls: 0,
      createSignedUrlResponse: {
        data: { signedUrl: 'https://supabase.example/dead' },
        error: null,
      },
    };

    await assert.rejects(
      async () =>
        getLogoPath('rid/dead-thermal.png', 'dead00000000', makeMockSupabase(state), {
          cacheDirOverride: tmpDir,
        }),
      /logo download failed.*404/i,
    );
  });
});
