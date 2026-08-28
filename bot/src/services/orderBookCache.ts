import { EventEmitter } from 'events';
import { prisma } from '../db';

const DEFAULT_TOP_LEVELS = 10;
const MIN_TOP_LEVELS = 3;
const MAX_TOP_LEVELS = 25;
const CONFIG_CACHE_MS = 5_000;

export interface BookLevel {
  odds: number; // taker implied probability
  size: number; // taker USDC
}

export interface BookSides {
  outcomeOne: BookLevel[]; // for taker betting outcomeOne
  outcomeTwo: BookLevel[]; // for taker betting outcomeTwo
}

interface StoredBook extends BookSides {
  version: string | null; // null = seeded via REST, no version to gate on
}

/**
 * V3 change from the old per-order-delta model: the orderbook_v3 WS channel
 * (and the orderbook-v3/snapshot REST endpoint) both hand back the FULL book
 * already aggregated by price level, every time — "replace, don't merge." So
 * this cache just stores whatever levels it was last given per market; there
 * is no more per-orderHash bookkeeping or manual price-bucketing here.
 *
 * Callers (centrifugo.ts) are responsible for the maker→taker inversion when
 * feeding WS publications (the orderbook_v3 channel is maker-frame only) —
 * this cache always stores already-taker-frame levels, both from WS and from
 * the REST seed (which uses showTakerPerspective=true and needs no inversion).
 *
 * `version` gating: WS publications carry a monotonic version string and
 * must only be applied if strictly greater than the one already held, per
 * https://docs.sx.bet/developers/book-versioning. REST seeds don't compete
 * with this — pass version=null for a seed and it always applies.
 */
export class OrderBookCache extends EventEmitter {
  private books = new Map<string, StoredBook>();
  private topLevels = DEFAULT_TOP_LEVELS;
  private configFetchedAt = 0;
  private configInflight: Promise<void> | null = null;

  private async refreshTopLevels(): Promise<void> {
    if (Date.now() - this.configFetchedAt < CONFIG_CACHE_MS) return;
    if (this.configInflight) return this.configInflight;
    this.configInflight = (async () => {
      try {
        const row = await prisma.botConfig.findUnique({ where: { key: 'orderBookLevels' } });
        const parsed = row ? parseInt(row.value, 10) : NaN;
        if (!isNaN(parsed)) {
          this.topLevels = Math.max(MIN_TOP_LEVELS, Math.min(MAX_TOP_LEVELS, parsed));
        }
        this.configFetchedAt = Date.now();
      } catch {
        this.configFetchedAt = Date.now();
      } finally {
        this.configInflight = null;
      }
    })();
    return this.configInflight;
  }

  setTopLevels(n: number): void {
    this.topLevels = Math.max(MIN_TOP_LEVELS, Math.min(MAX_TOP_LEVELS, n));
    this.configFetchedAt = Date.now();
  }

  getTopLevels(): number {
    return this.topLevels;
  }

  /**
   * Set the full book for a market. `version`: pass the WS publication's
   * version string for live updates (skipped if not strictly greater than
   * what's held), or null for a REST seed (always applied).
   */
  setBook(marketHash: string, sides: BookSides, version: string | null): void {
    const held = this.books.get(marketHash);
    if (version !== null && held?.version != null && version <= held.version) {
      return; // stale WS publication — ignore per the version-gating rule
    }

    const sortedOne = [...sides.outcomeOne].sort((a, b) => a.odds - b.odds).slice(0, this.topLevels);
    const sortedTwo = [...sides.outcomeTwo].sort((a, b) => a.odds - b.odds).slice(0, this.topLevels);

    this.books.set(marketHash, { outcomeOne: sortedOne, outcomeTwo: sortedTwo, version });
    void this.refreshTopLevels();
    this.emitUpdate(marketHash);
  }

  clearMarket(marketHash: string): void {
    this.books.delete(marketHash);
  }

  getLevels(marketHash: string): BookSides {
    const book = this.books.get(marketHash);
    if (!book) return { outcomeOne: [], outcomeTwo: [] };
    return { outcomeOne: book.outcomeOne.slice(0, this.topLevels), outcomeTwo: book.outcomeTwo.slice(0, this.topLevels) };
  }

  private emitUpdate(marketHash: string): void {
    const levels = this.getLevels(marketHash);
    this.emit('bookUpdate', { marketHash, ...levels });
  }
}

export const orderBookCache = new OrderBookCache();
