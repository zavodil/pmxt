/**
 * Param-forwarding contract test: auto-discovers all fetchRaw* methods
 * from TypeScript source, then verifies each forwards user params to
 * the outgoing API call.
 */

import path from 'path';
import { discoverTestMatrix, DiscoveredMethod } from './param-discovery';

import { PolymarketFetcher } from '../../src/exchanges/polymarket/fetcher';
import { KalshiFetcher } from '../../src/exchanges/kalshi/fetcher';
import { MyriadFetcher } from '../../src/exchanges/myriad/fetcher';
import { ProbableFetcher } from '../../src/exchanges/probable/fetcher';
import { SmarketsFetcher } from '../../src/exchanges/smarkets/fetcher';
import { HyperliquidFetcher } from '../../src/exchanges/hyperliquid/fetcher';
import { OpinionFetcher } from '../../src/exchanges/opinion/fetcher';
import { LimitlessFetcher } from '../../src/exchanges/limitless/fetcher';
import { GeminiFetcher } from '../../src/exchanges/gemini-titan/fetcher';

const FETCHER_FACTORIES: Record<string, (ctx: any, http: any) => any> = {
    polymarket:     (ctx, http) => new PolymarketFetcher(ctx, http),
    kalshi:         (ctx) => new KalshiFetcher(ctx),
    myriad:         (ctx) => new MyriadFetcher(ctx),
    probable:       (ctx) => new ProbableFetcher(ctx),
    smarkets:       (ctx) => new SmarketsFetcher(ctx),
    hyperliquid:    (ctx) => new HyperliquidFetcher(ctx, 'https://fake'),
    opinion:        (ctx) => new OpinionFetcher(ctx),
    limitless:      (ctx, http) => new LimitlessFetcher(ctx, http),
    'gemini-titan': (ctx) => new GeminiFetcher(ctx, 'https://fake'),
};

// Exchange-specific IDs that pass each venue's format validation.
const EXCHANGE_IDS: Record<string, string> = {
    hyperliquid: 'hl-outcome-1',
    myriad:      '1:2:3',
};

const SENTINELS: Record<string, { value: unknown; needles: string[] }> = {
    number:     { value: 770001, needles: ['770001'] },
    Date:       { value: new Date('2099-01-01T00:00:00Z'), needles: ['2099', '4070908800'] },
    string:     { value: 'SENTINEL_770003', needles: ['SENTINEL_770003'] },
    'string[]': { value: ['SENTINEL_770004'], needles: ['SENTINEL_770004'] },
};

// resolution is mapped through lookup tables (e.g., '1h' -> 60), so a
// string sentinel can never survive. Skip it — resolution forwarding is
// a mapping test, not a forwarding test.
const SKIP_FIELDS = new Set(['resolution']);

function createMockCtx() {
    const captured: unknown[] = [];
    const noopResponse = {
        data: { data: [], result: { list: [], total: 0 }, trades: [], fills: [], account_activity: [], cursor: '' },
    };
    const mockHttp: any = {
        get:     async (_url: string, opts?: any) => { captured.push(opts?.params ?? {}); return noopResponse; },
        post:    async (_url: string, data?: any) => { captured.push(data ?? {}); return noopResponse; },
        request: async (config: any) => { captured.push(config.params ?? config.data ?? {}); return noopResponse; },
    };
    const ctx: any = {
        http: mockHttp,
        callApi: async (_op: string, params?: any) => { captured.push(params ?? {}); return []; },
        getHeaders: () => ({}),
    };
    return { ctx, mockHttp, captured };
}

function buildArgs(pattern: string, params: Record<string, unknown>, exchange: string): unknown[] {
    const id = EXCHANGE_IDS[exchange] || 'FAKE_ID';
    switch (pattern) {
        case 'params-only':     return [params];
        case 'id-params':       return [id, params];
        case 'params-wallet':   return [params, '0xFAKE_WALLET'];
        default:                return [id, params];
    }
}

function hasSentinel(captured: unknown[], needles: string[]): boolean {
    const serialized = JSON.stringify(captured);
    return needles.some((n) => serialized.includes(n));
}

describe('param forwarding (fetcher level)', () => {
    const matrix = discoverTestMatrix(path.resolve(__dirname, '../../src'));

    // fetchRawMarkets and fetchRawEvents have their params (limit, offset, sort, etc.)
    // handled client-side by BaseExchange.fetchMarketsImpl/fetchEventsImpl — these are
    // intentionally NOT forwarded to the fetcher's upstream API call.
    const SKIP_METHODS = new Set(['fetchRawMarkets', 'fetchRawEvents']);

    const grouped = new Map<string, DiscoveredMethod[]>();
    for (const entry of matrix) {
        if (!FETCHER_FACTORIES[entry.exchange]) continue;
        if (SKIP_METHODS.has(entry.method)) continue;
        const list = grouped.get(entry.exchange) ?? [];
        list.push(entry);
        grouped.set(entry.exchange, list);
    }

    for (const [exchange, methods] of grouped) {
        describe(exchange, () => {
            for (const method of methods) {
                for (const field of method.fields) {
                    if (SKIP_FIELDS.has(field.name)) continue;
                    const sentinel = SENTINELS[field.type];
                    if (!sentinel) continue;

                    it(`${method.method} forwards ${field.name}`, async () => {
                        const { ctx, mockHttp, captured } = createMockCtx();
                        const fetcher = FETCHER_FACTORIES[exchange](ctx, mockHttp);

                        if (typeof fetcher[method.method] !== 'function') return;

                        const params = { [field.name]: sentinel.value };
                        const args = buildArgs(method.argPattern, params, exchange);

                        try {
                            await fetcher[method.method](...args);
                        } catch {
                            // errors expected — we only care about what was sent
                        }

                        expect(hasSentinel(captured, sentinel.needles)).toBe(true);
                    });
                }
            }
        });
    }
});
