/**
 * @license
 * Polymarket WebSocket implementation for pmxt.
 *
 * NOTICE: This implementation depends on "@nevuamarkets/poly-websockets",
 * which is licensed under the MIT License.
 */

import { SubscribedAddressSnapshot, SubscriptionOption } from '../../subscriber/base';
import { logger } from '../../utils/logger';
import {
    buildPolymarketActivity,
    GoldSkySubscriber,
    POLYMARKET_DEFAULT_SUBSCRIPTION,
} from '../../subscriber/external/goldsky';
import { AddressWatcher, WatcherConfig } from '../../subscriber/watcher';
import { OrderBook, OrderLevel, QueuedPromise, Trade } from '../../types';
import { DEFAULT_WATCH_TIMEOUT_MS, withWatchTimeout } from '../../utils/watch-timeout';


export interface PolymarketUserChannelCreds {
    apiKey: string;
    secret: string;
    passphrase: string;
}

export interface UserTradeEvent {
    asset_id: string;
    event_type: 'trade';
    price: string;
    size: string;
    side: string;
    status: string; // MATCHED, MINED, CONFIRMED, RETRYING, FAILED
    maker_orders?: any[];
    timestamp?: string;
}

export interface UserOrderEvent {
    asset_id: string;
    event_type: 'order';
    order_id: string;
    price: string;
    original_size: string;
    matched_size?: string;
    side: string;
    type: string; // PLACEMENT, UPDATE, CANCELLATION
    timestamp?: string;
}

export type UserChannelEvent = UserTradeEvent | UserOrderEvent;
export type UserChannelCallback = (event: UserChannelEvent) => void;

export interface PolymarketWebSocketConfig {
    /** Reconnection check interval in milliseconds (default: 5000) */
    reconnectIntervalMs?: number;
    /** Pending subscription flush interval in milliseconds (default: 100) */
    flushIntervalMs?: number;
    /** Watcher subscription configurations */
    watcherConfig?: WatcherConfig;
    /** Timeout in ms for watch methods to receive data (default: 30000). 0 = no timeout. */
    watchTimeoutMs?: number;
    /** API credentials for the authenticated user channel (fills/orders). */
    userChannelCreds?: PolymarketUserChannelCreds;
}

const POLYMARKET_MARKET_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

/**
 * Native WebSocket implementation for Polymarket market data.
 * Replaces the @nevuamarkets/poly-websockets dependency.
 */
export class PolymarketWebSocket {
    private ws: any;
    private subscribedAssets = new Set<string>();
    private readonly watcher: AddressWatcher;
    private orderBookResolvers = new Map<string, QueuedPromise<OrderBook>[]>();
    private tradeResolvers = new Map<string, QueuedPromise<Trade[]>[]>();
    private pendingTrades = new Map<string, Trade[]>();
    private orderBooks = new Map<string, OrderBook>();
    private config: PolymarketWebSocketConfig;
    private initializationPromise?: Promise<void>;

    constructor(callApi: (operationId: string, params?: Record<string, any>) => Promise<any>, config: PolymarketWebSocketConfig = {}) {
        this.config = config;
        const watcherConfig = this.config.watcherConfig;
        const subscriber = new GoldSkySubscriber({
            ...watcherConfig,
            buildSubscription: POLYMARKET_DEFAULT_SUBSCRIPTION,
        });
        this.watcher = new AddressWatcher(
            (address, types) => callApi('fetchWatchedAddressActivity', { address, types }),
            {
                subscriber,
                buildActivity: buildPolymarketActivity,
            },
        );
    }

    async watchOrderBook(outcomeId: string): Promise<OrderBook> {
        await this.ensureInitialized();
        await this.subscribe([outcomeId]);

        // Return a promise that resolves on the next orderbook update
        const dataPromise = new Promise<OrderBook>((resolve, reject) => {
            if (!this.orderBookResolvers.has(outcomeId)) {
                this.orderBookResolvers.set(outcomeId, []);
            }
            this.orderBookResolvers.get(outcomeId)!.push({ resolve, reject });
        });

        return withWatchTimeout(
            dataPromise,
            this.config.watchTimeoutMs ?? DEFAULT_WATCH_TIMEOUT_MS,
            `watchOrderBook('${outcomeId}')`,
        );
    }

    async unwatchOrderBook(outcomeId: string): Promise<void> {
        this.subscribedAssets.delete(outcomeId);

        // Clear any pending resolvers for this asset
        const resolvers = this.orderBookResolvers.get(outcomeId);
        if (resolvers) {
            this.orderBookResolvers = new Map(
                [...this.orderBookResolvers].filter(([key]) => key !== outcomeId),
            );
        }

        // Remove the cached orderbook for this asset
        if (this.orderBooks.has(outcomeId)) {
            this.orderBooks = new Map(
                [...this.orderBooks].filter(([key]) => key !== outcomeId),
            );
        }
    }

    async watchTrades(outcomeId: string, address?: string): Promise<Trade[]> {
        if (address) {
            return this.watcher.watch(address, ['trades'], outcomeId);
        }

        await this.ensureInitialized();
        await this.subscribe([outcomeId]);

        // Return accumulated trades immediately if any arrived between calls
        const accumulated = this.pendingTrades.get(outcomeId);
        if (accumulated && accumulated.length > 0) {
            const result = [...accumulated];
            this.pendingTrades.set(outcomeId, []);
            return result;
        }

        // Otherwise wait for the next trade
        const dataPromise = new Promise<Trade[]>((resolve, reject) => {
            if (!this.tradeResolvers.has(outcomeId)) {
                this.tradeResolvers.set(outcomeId, []);
            }
            this.tradeResolvers.get(outcomeId)!.push({ resolve, reject });
        });

        return withWatchTimeout(
            dataPromise,
            this.config.watchTimeoutMs ?? DEFAULT_WATCH_TIMEOUT_MS,
            `watchTrades('${outcomeId}')`,
        );
    }

    async watchAddress(address: string, types: SubscriptionOption[]): Promise<SubscribedAddressSnapshot> {
        return this.watcher.watch(address, types);
    }

    async unwatchAddress(address: string): Promise<void> {
        return this.watcher.unwatch(address);
    }

    // -----------------------------------------------------------------
    // Authenticated User Channel (fills + order updates)
    // -----------------------------------------------------------------

    private userWs: any = null;
    private userCallbacks: UserChannelCallback[] = [];
    private userPingInterval: ReturnType<typeof setInterval> | null = null;
    private userReconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private userConditionIds: string[] = [];

    /**
     * Subscribe to authenticated fill/order events via Polymarket's user channel.
     * Requires `userChannelCreds` in the config.
     *
     * @param conditionIds - Market condition IDs to monitor
     * @param callback     - Called for each trade or order event
     */
    async watchUserFills(conditionIds: string[], callback: UserChannelCallback): Promise<void> {
        const creds = this.config.userChannelCreds;
        if (!creds) {
            throw new Error(
                'User channel requires API credentials. Pass userChannelCreds in PolymarketWebSocketConfig.',
            );
        }
        this.userCallbacks.push(callback);
        this.userConditionIds = [...new Set([...this.userConditionIds, ...conditionIds])];

        if (this.userWs) {
            // Already connected — just re-subscribe with updated condition IDs.
            this.sendUserSubscription(creds);
            return;
        }

        await this.connectUserChannel(creds);
    }

    /**
     * Stop watching user fills and close the user channel WebSocket.
     */
    async unwatchUserFills(): Promise<void> {
        this.userCallbacks = [];
        this.userConditionIds = [];
        this.closeUserChannel();
    }

    private async connectUserChannel(creds: PolymarketUserChannelCreds): Promise<void> {
        const WebSocket = (await import('ws')).default;
        const url = 'wss://ws-subscriptions-clob.polymarket.com/ws/user';

        this.userWs = new WebSocket(url);

        this.userWs.on('open', () => {
            logger.debug('[polymarket-ws] user channel connected');
            this.sendUserSubscription(creds);

            // Ping every 10 seconds to keep the connection alive.
            if (this.userPingInterval) clearInterval(this.userPingInterval);
            this.userPingInterval = setInterval(() => {
                if (this.userWs?.readyState === WebSocket.OPEN) {
                    this.userWs.ping();
                }
            }, 10_000);
        });

        this.userWs.on('message', (raw: Buffer) => {
            try {
                const events: UserChannelEvent[] = JSON.parse(raw.toString());
                const arr = Array.isArray(events) ? events : [events];
                for (const event of arr) {
                    for (const cb of this.userCallbacks) {
                        try { cb(event); } catch (e: unknown) {
                            logger.error('[polymarket-ws] user callback error', { error: e instanceof Error ? e.message : String(e) });
                        }
                    }
                }
            } catch {
                // Non-JSON control message (pong, etc.) — ignore.
            }
        });

        this.userWs.on('close', () => {
            logger.warn('[polymarket-ws] user channel disconnected, reconnecting in 5s');
            this.scheduleUserReconnect(creds);
        });

        this.userWs.on('error', (err: Error) => {
            logger.error('[polymarket-ws] user channel error', { error: err.message });
        });
    }

    private sendUserSubscription(creds: PolymarketUserChannelCreds): void {
        if (!this.userWs || this.userWs.readyState !== 1) return;
        const msg = JSON.stringify({
            auth: {
                apiKey: creds.apiKey,
                secret: creds.secret,
                passphrase: creds.passphrase,
            },
            markets: this.userConditionIds,
            type: 'user',
        });
        this.userWs.send(msg);
    }

    private scheduleUserReconnect(creds: PolymarketUserChannelCreds): void {
        if (this.userReconnectTimer) return;
        this.userReconnectTimer = setTimeout(async () => {
            this.userReconnectTimer = null;
            if (this.userCallbacks.length > 0) {
                try { await this.connectUserChannel(creds); } catch (e: any) {
                    logger.error('[polymarket-ws] reconnect failed', { error: e.message });
                    this.scheduleUserReconnect(creds);
                }
            }
        }, 5000);
    }

    private closeUserChannel(): void {
        if (this.userPingInterval) { clearInterval(this.userPingInterval); this.userPingInterval = null; }
        if (this.userReconnectTimer) { clearTimeout(this.userReconnectTimer); this.userReconnectTimer = null; }
        if (this.userWs) { this.userWs.close(); this.userWs = null; }
    }

    async close() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.subscribedAssets.clear();
        this.closeUserChannel();
        this.watcher.close();
    }

    private async subscribe(assetIds: string[]) {
        const newIds = assetIds.filter((id) => !this.subscribedAssets.has(id));
        if (newIds.length === 0) return;

        for (const id of newIds) this.subscribedAssets.add(id);

        if (this.ws && this.ws.readyState === 1) {
            this.ws.send(JSON.stringify({
                assets_ids: newIds,
                type: 'market',
                custom_feature_enabled: true,
            }));
        }
    }

    private async ensureInitialized() {
        if (this.initializationPromise) return this.initializationPromise;

        this.initializationPromise = new Promise<void>((resolve, reject) => {
            const WebSocket = require('ws');
            this.ws = new WebSocket(POLYMARKET_MARKET_WS_URL);

            this.ws.on('open', () => {
                resolve();
            });

            this.ws.on('message', (raw: any) => {
                try {
                    const msgs = JSON.parse(raw.toString());
                    const arr = Array.isArray(msgs) ? msgs : [msgs];
                    for (const msg of arr) {
                        const type = msg.event_type;
                        if (type === 'book') this.handleBookSnapshot(msg);
                        else if (type === 'price_change') this.handlePriceChange(msg);
                        else if (type === 'last_trade_price') this.handleTrade(msg);
                    }
                } catch (e: unknown) {
                    logger.error('[polymarket-ws] market message handler error', {
                        error: e instanceof Error ? e.message : String(e),
                    });
                }
            });

            this.ws.on('error', (err: Error) => {
                logger.error('[polymarket-ws] WebSocket error', { error: err.message });
                reject(err);
            });

            this.ws.on('close', () => {
                this.initializationPromise = undefined;
                this.ws = null;
            });
        });

        return this.initializationPromise;
    }

    private handleBookSnapshot(event: any) {
        const id = event.asset_id;

        const bids: OrderLevel[] = event.bids.map((b: any) => ({
            price: parseFloat(b.price),
            size: parseFloat(b.size),
        })).sort((a: any, b: any) => b.price - a.price);

        const asks: OrderLevel[] = event.asks.map((a: any) => ({
            price: parseFloat(a.price),
            size: parseFloat(a.size),
        })).sort((a: any, b: any) => a.price - b.price);

        const orderBook: OrderBook = {
            bids,
            asks,
            timestamp: event.timestamp ? (isNaN(Number(event.timestamp)) ? new Date(event.timestamp).getTime() : Number(event.timestamp)) : Date.now(),
        };

        this.orderBooks.set(id, orderBook);
        this.resolveOrderBook(id, orderBook);
    }

    private handlePriceChange(event: any) {
        const id = event.asset_id;
        const existing = this.orderBooks.get(id);

        if (!existing) return;

        // Native API sends individual price_change events (not wrapped in an array)
        const changes = event.price_changes || [event];
        for (const change of changes) {
            const price = parseFloat(change.price);
            const size = parseFloat(change.size);
            const side = (change.side || '').toUpperCase();

            const levels = side === 'BUY' ? existing.bids : existing.asks;
            const existingIndex = levels.findIndex((l) => l.price === price);

            if (size === 0) {
                // Remove level
                if (existingIndex !== -1) {
                    levels.splice(existingIndex, 1);
                }
            } else {
                // Update or add level
                if (existingIndex !== -1) {
                    levels[existingIndex].size = size;
                } else {
                    levels.push({ price, size });
                    // Re-sort
                    if (side === 'BUY') {
                        levels.sort((a, b) => b.price - a.price);
                    } else {
                        levels.sort((a, b) => a.price - b.price);
                    }
                }
            }

            existing.timestamp = event.timestamp ? (isNaN(Number(event.timestamp)) ? new Date(event.timestamp).getTime() : Number(event.timestamp)) : Date.now();
            this.resolveOrderBook(id, existing);
        }
    }

    private handleTrade(event: any) {
        const id = event.asset_id;

        const trade: Trade = {
            id: `${event.timestamp}-${Math.random()}`,
            timestamp: event.timestamp ? (isNaN(Number(event.timestamp)) ? new Date(event.timestamp).getTime() : Number(event.timestamp)) : Date.now(),
            price: parseFloat(event.price),
            amount: parseFloat(event.size),
            side: event.side.toLowerCase() as 'buy' | 'sell' | 'unknown',
        };

        // Resolve waiting promises if any, otherwise buffer for next watchTrades call
        const resolvers = this.tradeResolvers.get(id);
        if (resolvers && resolvers.length > 0) {
            resolvers.forEach((r) => r.resolve([trade]));
            this.tradeResolvers.set(id, []);
        } else {
            if (!this.pendingTrades.has(id)) {
                this.pendingTrades.set(id, []);
            }
            this.pendingTrades.get(id)!.push(trade);
        }
    }

    private resolveOrderBook(id: string, orderBook: OrderBook) {
        const resolvers = this.orderBookResolvers.get(id);
        if (resolvers && resolvers.length > 0) {
            resolvers.forEach((r) => r.resolve(orderBook));
            this.orderBookResolvers.set(id, []);
        }
    }
}
