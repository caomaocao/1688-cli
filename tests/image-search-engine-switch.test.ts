import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The engine switch must leave the page path untouched and route `plugin`
// to the plugin executor. Both the daemon dispatch and the plugin executor
// are mocked so no browser is involved.

const dispatchMock = vi.fn(async () => ({ imageId: 'x', total: 0, offers: [] }));
vi.mock('../src/session/dispatch.js', () => ({ dispatch: dispatchMock }));

const pluginExecuteMock = vi.fn(async () => ({
  engine: 'plugin',
  imageId: '1',
  total: 0,
  offers: [],
  region: null,
  yoloCropRegion: [],
  pagesFetched: 1,
}));
vi.mock('../src/commands/image-search-plugin.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/commands/image-search-plugin.js')>();
  return { ...actual, execute: pluginExecuteMock };
});

vi.mock('../src/io/output.js', () => ({
  emit: vi.fn(),
  info: vi.fn(),
}));

let tmpDir: string;
let imagePath: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb1688-engine-'));
  imagePath = path.join(tmpDir, 'img.jpg');
  await fs.writeFile(imagePath, Buffer.from('jpg'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  dispatchMock.mockClear();
  pluginExecuteMock.mockClear();
});

describe('image-search engine switch (run)', () => {
  it('dispatches engine=page with max 20 when no flags are given', async () => {
    const { run } = await import('../src/commands/image-search.js');
    await run({ imagePath });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const [name, args] = dispatchMock.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(name).toBe('image-search');
    expect(args).toMatchObject({ engine: 'page', max: 20, imagePath: path.resolve(imagePath) });
  });

  it('dispatches engine=plugin with max 40 by default, honours --max and nests the plugin flags', async () => {
    const { run } = await import('../src/commands/image-search.js');
    await run({ imagePath, engine: 'plugin' });
    expect(dispatchMock.mock.calls[0]?.[1]).toEqual({
      imagePath: path.resolve(imagePath),
      max: 40,
      headed: undefined,
      engine: 'plugin',
      plugin: { region: null, imageId: null, raw: false },
    });
    await run({ imagePath, engine: 'plugin', max: '7', region: '1,2,3,4', raw: true });
    expect(dispatchMock.mock.calls[1]?.[1]).toMatchObject({
      engine: 'plugin',
      max: 7,
      plugin: { region: '1,2,3,4', imageId: null, raw: true },
    });
    await run({ engine: 'plugin', imageId: '99' });
    expect(dispatchMock.mock.calls[2]?.[1]).toMatchObject({
      imagePath: null,
      plugin: { imageId: '99' },
    });
  });

  it('does not nest plugin flags for the page engine', async () => {
    const { run } = await import('../src/commands/image-search.js');
    await run({ imagePath });
    expect(dispatchMock.mock.calls[0]?.[1]).not.toHaveProperty('plugin');
  });

  it('rejects an oversize image for the plugin engine before dispatch, but not for the page engine', async () => {
    const { run } = await import('../src/commands/image-search.js');
    const big = path.join(tmpDir, 'big.jpg');
    await fs.writeFile(big, Buffer.alloc(3.2 * 1024 * 1024)); // ~4.3 MB base64
    await expect(run({ imagePath: big, engine: 'plugin' })).rejects.toMatchObject({
      code: 'BAD_INPUT',
      message: expect.stringContaining('too large'),
    });
    expect(dispatchMock).not.toHaveBeenCalled();
    await run({ imagePath: big });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown engine before dispatching', async () => {
    const { run } = await import('../src/commands/image-search.js');
    await expect(run({ imagePath, engine: 'nope' })).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

describe('image-search engine switch (execute)', () => {
  it('routes engine=plugin to the plugin executor with the search args', async () => {
    const { execute } = await import('../src/commands/image-search.js');
    const ctx = {} as BrowserContext;
    const result = await execute(ctx, {
      imagePath,
      max: 40,
      engine: 'plugin',
      plugin: { region: '1,2,3,4', imageId: null, raw: true },
    });
    expect(pluginExecuteMock).toHaveBeenCalledTimes(1);
    expect(pluginExecuteMock.mock.calls[0]?.[1]).toEqual({
      imagePath,
      imageId: null,
      region: '1,2,3,4',
      raw: true,
      max: 40,
      headed: undefined,
    });
    expect(result).toMatchObject({ engine: 'plugin', imageId: '1' });
  });

  it('does not touch the plugin executor for the page engine', async () => {
    const { execute } = await import('../src/commands/image-search.js');
    // A context whose newPage fails immediately: the page path is entered
    // (and fails), the plugin executor is never consulted.
    const ctx = {
      newPage: async () => {
        throw new Error('Target page, context or browser has been closed');
      },
      pages: () => [],
      on: () => ctx,
      off: () => ctx,
      removeListener: () => ctx,
    } as unknown as BrowserContext;
    await expect(execute(ctx, { imagePath, max: 20, engine: 'page' })).rejects.toBeTruthy();
    await expect(execute(ctx, { imagePath, max: 20 })).rejects.toBeTruthy();
    expect(pluginExecuteMock).not.toHaveBeenCalled();
  });
});
