import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setOutputFlags } from '../src/io/output.js';

const { dispatchMock } = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
}));

vi.mock('../src/session/dispatch.js', () => ({
  dispatch: dispatchMock,
}));

import { run } from '../src/commands/offer.js';

let stdout = '';
let stderr = '';
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stdout = '';
  stderr = '';
  dispatchMock.mockReset();
  setOutputFlags({ json: true, cmd: 'offer' });
  stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    });
  stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    });
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  setOutputFlags({ json: false, jsonV2: false, pretty: false });
});

describe('offer run', () => {
  it('keeps single-offer JSON shape while allowing --pro inline dispatch', async () => {
    dispatchMock.mockResolvedValueOnce(offerResult('100'));

    await run({ offerIds: ['100'], pro: true, profile: 'buyer' });

    expect(dispatchMock).toHaveBeenCalledWith(
      'offer',
      { offerId: '100', headed: undefined, profile: 'buyer' },
      { headed: undefined, profile: 'buyer', noDaemon: true },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      offerId: '100',
      title: 'Offer 100',
    });
    expect(JSON.parse(stdout)).not.toHaveProperty('mode');
  });

  it('wraps multiple offers in a batch envelope and isolates bad IDs', async () => {
    dispatchMock.mockResolvedValueOnce(offerResult('100'));
    dispatchMock.mockResolvedValueOnce(offerResult('200'));

    await run({ offerIds: ['100', 'bad', '200'], pro: true });

    expect(dispatchMock).toHaveBeenCalledTimes(2);
    expect(dispatchMock).toHaveBeenNthCalledWith(
      1,
      'offer',
      { offerId: '100', headed: undefined, profile: undefined },
      { headed: undefined, profile: undefined, noDaemon: true },
    );
    expect(dispatchMock).toHaveBeenNthCalledWith(
      2,
      'offer',
      { offerId: '200', headed: undefined, profile: undefined },
      { headed: undefined, profile: undefined, noDaemon: true },
    );

    expect(JSON.parse(stdout)).toMatchObject({
      mode: 'batch',
      total: 3,
      success: 2,
      failed: 1,
      offerIds: ['100', 'bad', '200'],
      offers: [{ offerId: '100' }, { offerId: '200' }],
      failures: [{ offerId: 'bad', code: 'BAD_INPUT' }],
    });
    expect(stderr).toContain('[1/3] collecting offerId 100');
    expect(stderr).toContain('[3/3] collecting offerId 200');
  });
});

function offerResult(offerId: string) {
  return {
    offerId,
    title: `Offer ${offerId}`,
    url: `https://detail.1688.com/offer/${offerId}.html`,
    priceRange: '¥1.00',
    priceMin: 1,
    priceMax: 1,
    unitName: '件',
    minOrderQty: 1,
    mixOrderQty: null,
    priceTiers: [],
    detailUrl: null,
    attributes: [],
    packageInfo: [],
    supplier: { name: null, loginId: null, memberId: null, userId: null },
    freight: {
      receiveAddress: null,
      sendArea: null,
      province: null,
      city: null,
      unitWeight: null,
    },
    saledCount: null,
    categoryId: null,
    options: [],
    skus: [],
    mainImage: null,
    images: ['https://img.example/1.jpg'],
  };
}
