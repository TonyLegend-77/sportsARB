import { describe, it, expect, beforeEach } from 'vitest';
import { OrderBookCache } from './orderBookCache';

describe('OrderBookCache', () => {
  let cache: OrderBookCache;

  beforeEach(() => {
    cache = new OrderBookCache();
    cache.setTopLevels(10);
  });

  it('stores and returns levels for both sides', () => {
    cache.setBook(
      '0xmkt',
      { outcomeOne: [{ odds: 0.5, size: 10 }], outcomeTwo: [{ odds: 0.6, size: 15 }] },
      null,
    );

    const { outcomeOne, outcomeTwo } = cache.getLevels('0xmkt');
    expect(outcomeOne).toHaveLength(1);
    expect(outcomeTwo).toHaveLength(1);
    expect(outcomeOne[0].odds).toBeCloseTo(0.5, 6);
    expect(outcomeTwo[0].odds).toBeCloseTo(0.6, 6);
  });

  it('sorts levels ascending by odds regardless of input order', () => {
    cache.setBook(
      '0xmkt',
      {
        outcomeOne: [
          { odds: 0.7, size: 5 },
          { odds: 0.4, size: 8 },
        ],
        outcomeTwo: [],
      },
      null,
    );
    const { outcomeOne } = cache.getLevels('0xmkt');
    expect(outcomeOne.map((l) => l.odds)).toEqual([0.4, 0.7]);
  });

  it('a WS publication (versioned) replaces the whole book, not merges', () => {
    cache.setBook('0xmkt', { outcomeOne: [{ odds: 0.4, size: 10 }], outcomeTwo: [] }, '001');
    cache.setBook('0xmkt', { outcomeOne: [{ odds: 0.45, size: 20 }], outcomeTwo: [{ odds: 0.55, size: 5 }] }, '002');

    const { outcomeOne, outcomeTwo } = cache.getLevels('0xmkt');
    expect(outcomeOne).toHaveLength(1);
    expect(outcomeOne[0].odds).toBeCloseTo(0.45, 6);
    expect(outcomeTwo).toHaveLength(1);
  });

  it('ignores a WS publication whose version is not strictly greater than the held one', () => {
    cache.setBook('0xmkt', { outcomeOne: [{ odds: 0.4, size: 10 }], outcomeTwo: [] }, '005');
    cache.setBook('0xmkt', { outcomeOne: [{ odds: 0.99, size: 1 }], outcomeTwo: [] }, '003'); // stale — lower version
    cache.setBook('0xmkt', { outcomeOne: [{ odds: 0.99, size: 1 }], outcomeTwo: [] }, '005'); // stale — equal version

    expect(cache.getLevels('0xmkt').outcomeOne[0].odds).toBeCloseTo(0.4, 6);
  });

  it('a REST seed (version=null) always applies, bypassing version gating', () => {
    cache.setBook('0xmkt', { outcomeOne: [{ odds: 0.4, size: 10 }], outcomeTwo: [] }, '999');
    cache.setBook('0xmkt', { outcomeOne: [{ odds: 0.42, size: 12 }], outcomeTwo: [] }, null);

    expect(cache.getLevels('0xmkt').outcomeOne[0].odds).toBeCloseTo(0.42, 6);
  });

  it('setTopLevels bounds the returned levels count', () => {
    const levels = Array.from({ length: 20 }, (_, i) => ({ odds: 0.1 + i * 0.01, size: 10 }));
    cache.setBook('0xmkt', { outcomeOne: [], outcomeTwo: levels }, null);

    cache.setTopLevels(5);
    expect(cache.getLevels('0xmkt').outcomeTwo).toHaveLength(5);

    cache.setTopLevels(15);
    expect(cache.getLevels('0xmkt').outcomeTwo).toHaveLength(15);
  });

  it('emits bookUpdate on setBook', () => {
    const events: string[] = [];
    cache.on('bookUpdate', (payload: { marketHash: string }) => events.push(payload.marketHash));

    cache.setBook('0xmkt', { outcomeOne: [{ odds: 0.4, size: 10 }], outcomeTwo: [] }, null);

    expect(events).toEqual(['0xmkt']);
  });

  it('clearMarket removes all state', () => {
    cache.setBook('0xmkt', { outcomeOne: [{ odds: 0.4, size: 10 }], outcomeTwo: [] }, null);
    cache.clearMarket('0xmkt');
    expect(cache.getLevels('0xmkt').outcomeOne).toHaveLength(0);
    expect(cache.getLevels('0xmkt').outcomeTwo).toHaveLength(0);
  });
});
