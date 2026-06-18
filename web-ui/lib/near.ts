import type { NearConnector, SignedMessage } from '@hot-labs/near-connect';
import { login } from './api';

// Must byte-match the recipient the chat-api verifier reconstructs (NEP-413).
export const NEAR_RECIPIENT = 'prediction-copilot';

let connectorPromise: Promise<NearConnector> | null = null;
async function getConnector(): Promise<NearConnector> {
  if (!connectorPromise) {
    connectorPromise = import('@hot-labs/near-connect').then(
      ({ NearConnector }) => new NearConnector({ network: 'mainnet' }),
    );
  }
  return connectorPromise;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Connect a NEAR wallet, sign a NEP-413 challenge, and exchange it for a session JWT. */
export async function loginWithNear(): Promise<{ token: string; userId: string }> {
  const connector = await getConnector();
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const message = `Sign in to Prediction Copilot\nTime: ${new Date().toISOString()}`;

  const walletId = await connector.selectWallet({ features: { signMessage: true } });
  const wallet = await connector.wallet(walletId);
  try {
    await connector.connect({ walletId });
  } catch {
    // Some wallets sign in during selection; ignore a redundant connect.
  }
  const signed: SignedMessage = await wallet.signMessage({ message, recipient: NEAR_RECIPIENT, nonce });

  return login({
    chain: 'near',
    address: signed.accountId,
    message,
    signature: signed.signature,
    publicKey: signed.publicKey,
    nonce: toBase64(nonce),
    recipient: NEAR_RECIPIENT,
  });
}
