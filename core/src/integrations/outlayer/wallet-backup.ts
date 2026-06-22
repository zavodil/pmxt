// Opt-in offline wallet-recovery index (BACKUP_WALLETS). See appendWalletBackup.
import * as fs from 'fs';
import * as path from 'path';
import { ExchangeCredentials } from '../../BaseExchange';
import { resolveIdentity } from './factory';
import { logger } from '../../utils/logger';

const RECOVER_NOTE =
  'Control this wallet with OUTLAYER_ACCOUNT_ID + OUTLAYER_NEAR_PRIVATE_KEY (the app NEAR key, ' +
  'backed up SEPARATELY) + this seed: sign `Authorization: Bearer near:` over `auth:{seed}:{ts}` ' +
  'and call the OutLayer wallet API. Polymarket pUSD lives in the depositWallet (CREATE2 from the EOA).';

/**
 * Opt-in offline wallet-recovery index (port of ai-intents' wallet-backups.jsonl).
 *
 * When `BACKUP_WALLETS=true`, append one JSONL line per minted deposit address to
 * `BACKUP_WALLETS_FILE`, recording the per-user `seed` + derived address. Custody
 * is stateless — the seed is `sha256("predict:user:<userId>")`, recoverable from
 * the userId + the app NEAR key alone — so the file is NOT the custody secret; its
 * value is being an **offline index of which userIds/seeds ever existed**, so the
 * derived wallets can be re-enumerated and swept if the DB is lost. It IS sensitive
 * (lists seeds) and must stay gitignored + protected.
 *
 * Best-effort: never throws, never fails the caller (a backup hiccup must not break
 * the deposit the user just asked for). Off by default.
 */
export function appendWalletBackup(
  credentials: ExchangeCredentials | undefined,
  chain: string,
  depositAddress: string,
): void {
  if (process.env.BACKUP_WALLETS !== 'true') return;
  try {
    const { accountId, seed, vaultId } = resolveIdentity(credentials);
    const record = {
      ts: new Date().toISOString(),
      user_id: credentials?.outlayerUserId ?? null,
      seed,
      near_account_id: accountId,
      vault_id: vaultId ?? null,
      chain,
      deposit_address: depositAddress,
      recover: RECOVER_NOTE,
    };
    const file = process.env.BACKUP_WALLETS_FILE || 'wallet-backups/wallet-backups.jsonl';
    const dir = path.dirname(file);
    if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
    // Synchronous append: the Node event loop serializes calls, so single-line
    // appends can't interleave (no cross-process writers here).
    fs.appendFileSync(file, JSON.stringify(record) + '\n');
  } catch (e) {
    logger.error('[wallet-backup] failed to append recovery line (request still succeeded)', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
