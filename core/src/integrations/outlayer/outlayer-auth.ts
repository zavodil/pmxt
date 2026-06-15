/**
 * {@link BearerAuth} implementations for the OutLayer wallet API's two auth modes.
 *
 * `SeedBearerAuth` is the PREFERRED product path (deterministic `Bearer near:`,
 * per-user sub-wallet by `seed`, matching the agreed EVM-signing contract).
 * `WkBearerAuth` is the zero-NEAR-key alternative (a registered `wk_` custody
 * wallet). Both produce a full `Authorization` header so the rest of the
 * integration is auth-mode-agnostic.
 */
import { BearerAuth } from './types';
import { NearAuth } from './near-auth';

/** `Bearer near:<…>` bound to a single seed; re-minted (fresh timestamp) per call. */
export class SeedBearerAuth implements BearerAuth {
    constructor(private readonly near: NearAuth, private readonly seed: string) {}
    header(): string {
        return `Bearer ${this.near.makeBearer(this.seed)}`;
    }
}

/** `Bearer wk_<…>` — a static registered custody-wallet key (seed plays no role). */
export class WkBearerAuth implements BearerAuth {
    constructor(private readonly wkKey: string) {}
    header(): string {
        return `Bearer ${this.wkKey}`;
    }
}
