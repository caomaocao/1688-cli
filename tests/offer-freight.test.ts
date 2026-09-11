import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { freightOf, splitSendArea } from '../src/commands/offer.js';

function fixture(offerId: string): unknown {
  const path = fileURLToPath(
    new URL(`./fixtures/offer-freight-${offerId}.json`, import.meta.url),
  );
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('freightOf', () => {
  it('reads free shipping and the send area off a real sku response', () => {
    // 701556163346: ships free to the account's address, sent from 广东省汕头市
    const f = freightOf(fixture('701556163346') as never);
    expect(f.cost).toBe(0);
    expect(f.free).toBe(true);
    expect(f.sendArea).toBe('广东省汕头市');
    expect(f.divisionCode).toBe('440513');
    expect(f.province).toBe('广东');
    expect(f.city).toBe('汕头市');
    expect(f.receiveAddress).toBe('某省某市');
  });

  it('reads the quoted amount and a province-only send area', () => {
    // 1049842836796: 8 yuan to the account's address, and the seller only says 湖北省
    const f = freightOf(fixture('1049842836796') as never);
    expect(f.cost).toBe(8);
    expect(f.free).toBe(false);
    expect(f.sendArea).toBe('湖北省');
    expect(f.divisionCode).toBe('429004');
    expect(f.province).toBe('湖北');
    expect(f.city).toBeNull();
  });

  it('says nothing rather than zero when 1688 quotes nothing', () => {
    const f = freightOf({ skuSelectorModel: { freightInfo: { location: '浙江省金华市' } } } as never);
    expect(f.cost).toBeNull();
    expect(f.free).toBeNull();
    expect(f.sendArea).toBe('浙江省金华市');
    expect(f.divisionCode).toBeNull();
    expect(freightOf(undefined as never).sendArea).toBeNull();
    expect(freightOf(undefined as never).cost).toBeNull();
  });
});

describe('splitSendArea', () => {
  it('splits a send area the way a search card writes it', () => {
    expect(splitSendArea('广东省汕头市')).toEqual({ province: '广东', city: '汕头市' });
    expect(splitSendArea('湖北省')).toEqual({ province: '湖北', city: null });
    expect(splitSendArea('内蒙古自治区包头市')).toEqual({ province: '内蒙古', city: '包头市' });
    expect(splitSendArea('广西壮族自治区南宁市')).toEqual({ province: '广西', city: '南宁市' });
    expect(splitSendArea('上海市')).toEqual({ province: '上海', city: '上海市' });
    expect(splitSendArea('')).toEqual({ province: null, city: null });
    expect(splitSendArea(null)).toEqual({ province: null, city: null });
  });
});
