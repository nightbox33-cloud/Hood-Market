import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { getAddress } from 'viem';
import { logger } from '../logger.js';
import { petitionOpenDurationMs } from './petitionConfig.js';
import { normalizeCatalogTokenName, normalizeCatalogTickerSymbol } from './deploymentCatalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '../../.data');
const dbPath = path.join(dataDir, 'petition.db');

let db: sqlite3.Database | null = null;

export type PetitionStatus =
  | 'open'
  | 'locked'
  | 'finalizing'
  | 'finalized'
  | 'failed'
  | 'expired'
  | 'cancelled';

/** Statuses that reserve ticker + name from instant deploy. */
export const ACTIVE_COMMUNITY_LAUNCH_STATUSES: PetitionStatus[] = [
  'open',
  'locked',
  'finalizing',
];

export type PetitionRow = {
  id: number;
  created_at: string;
  expires_at: string;
  status: PetitionStatus;
  token_name: string;
  token_symbol: string;
  description: string;
  image_url: string;
  website_url: string;
  tweet_url: string;
  starter_wallet: string;
  max_units_per_wallet: number;
  supporter_slots: number | null;
  units_per_supporter: number | null;
  hood_claim_opt_in: number;
  goal_units: number;
  target_raise_wei: string;
  sold_units: number;
  token_address: string;
  deploy_tx_hash: string;
  airdrop_tx_hash: string;
  final_error: string;
  source_url: string;
};

export type PetitionOrderRow = {
  id: number;
  petition_id: number;
  wallet: string;
  units: number;
  launch_buy_wei: string;
  deposit_wei: string;
  deposit_tx_hash: string;
  status: string;
  created_at: string;
  refunded_at: string | null;
};

function run(sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error('petition DB not initialized'));
      return;
    }
    db.run(sql, params, (err) => (err ? reject(err) : resolve()));
  });
}

function get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error('petition DB not initialized'));
      return;
    }
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row as T | undefined)));
  });
}

function all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error('petition DB not initialized'));
      return;
    }
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve((rows as T[]) ?? [])));
  });
}

export function initPetitionDb(): void {
  if (db) return;
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch (err: unknown) {
    logger.warn('petitionDb: failed to create .data directory:', (err as Error).message);
  }

  db = new sqlite3.Database(dbPath, (err) => {
    if (err) logger.error('petitionDb: failed to open database:', err.message);
    else logger.info('Petition DB ready:', dbPath);
  });

  db.serialize(() => {
    db!.run(
      `CREATE TABLE IF NOT EXISTS petitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        token_name TEXT NOT NULL,
        token_symbol TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        image_url TEXT NOT NULL DEFAULT '',
        website_url TEXT NOT NULL DEFAULT '',
        tweet_url TEXT NOT NULL DEFAULT '',
        starter_wallet TEXT NOT NULL DEFAULT '',
        max_units_per_wallet INTEGER NOT NULL DEFAULT 10,
        supporter_slots INTEGER,
        units_per_supporter INTEGER,
        hood_claim_opt_in INTEGER NOT NULL DEFAULT 0,
        goal_units INTEGER NOT NULL DEFAULT 1000,
        target_raise_wei TEXT NOT NULL DEFAULT '0',
        sold_units INTEGER NOT NULL DEFAULT 0,
        token_address TEXT NOT NULL DEFAULT '',
        deploy_tx_hash TEXT NOT NULL DEFAULT '',
        airdrop_tx_hash TEXT NOT NULL DEFAULT '',
        final_error TEXT NOT NULL DEFAULT '',
        source_url TEXT NOT NULL DEFAULT ''
      )`,
    );
    db!.run(
      `CREATE INDEX IF NOT EXISTS idx_petitions_status ON petitions(status, created_at DESC)`,
    );
    db!.run(
      `CREATE INDEX IF NOT EXISTS idx_petitions_symbol ON petitions(token_symbol, status)`,
    );
    db!.run(
      `CREATE TABLE IF NOT EXISTS petition_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        petition_id INTEGER NOT NULL,
        wallet TEXT NOT NULL,
        units INTEGER NOT NULL,
        launch_buy_wei TEXT NOT NULL DEFAULT '0',
        deposit_wei TEXT NOT NULL DEFAULT '0',
        deposit_tx_hash TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        refunded_at DATETIME,
        UNIQUE(petition_id, wallet),
        FOREIGN KEY (petition_id) REFERENCES petitions(id)
      )`,
    );
    db!.run(
      `CREATE INDEX IF NOT EXISTS idx_petition_orders_petition ON petition_orders(petition_id, status)`,
    );
    db!.run(
      `ALTER TABLE petitions ADD COLUMN target_raise_wei TEXT NOT NULL DEFAULT '0'`,
      (err) => {
        if (err && !String(err.message).includes('duplicate column')) {
          logger.warn('petitionDb: target_raise_wei migration:', err.message);
        }
      },
    );
  });
}

export function closePetitionDb(): void {
  if (!db) return;
  db.close();
  db = null;
}

export function petitionDbReady(): boolean {
  return db != null;
}

export async function createPetition(input: {
  tokenName: string;
  tokenSymbol: string;
  description?: string;
  imageUrl?: string;
  websiteUrl?: string;
  tweetUrl?: string;
  starterWallet?: string;
  maxUnitsPerWallet: number;
  supporterSlots?: number;
  unitsPerSupporter?: number;
  hoodClaimOptIn?: boolean;
  goalUnits?: number;
  targetRaiseWei: string;
}): Promise<PetitionRow> {
  const durationMs = petitionOpenDurationMs();
  const expiresAt = new Date(Date.now() + durationMs).toISOString();
  let starter = '';
  if (input.starterWallet?.trim()) {
    try {
      starter = getAddress(input.starterWallet.trim());
    } catch {
      starter = input.starterWallet.trim().slice(0, 42);
    }
  }

  await run(
    `INSERT INTO petitions (
      expires_at, token_name, token_symbol, description, image_url, website_url, tweet_url,
      starter_wallet, max_units_per_wallet, supporter_slots, units_per_supporter,
      hood_claim_opt_in, goal_units, target_raise_wei
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      expiresAt,
      input.tokenName.slice(0, 64),
      input.tokenSymbol.slice(0, 16),
      (input.description ?? '').slice(0, 2000),
      (input.imageUrl ?? '').slice(0, 1024),
      (input.websiteUrl ?? '').slice(0, 1024),
      (input.tweetUrl ?? '').slice(0, 1024),
      starter,
      input.maxUnitsPerWallet,
      input.supporterSlots ?? null,
      input.unitsPerSupporter ?? null,
      input.hoodClaimOptIn ? 1 : 0,
      input.goalUnits ?? 1000,
      input.targetRaiseWei,
    ],
  );

  const row = await get<PetitionRow>(`SELECT * FROM petitions ORDER BY id DESC LIMIT 1`);
  if (!row) throw new Error('Failed to create petition');
  return row;
}

export async function getPetitionById(id: number): Promise<PetitionRow | undefined> {
  return get<PetitionRow>(`SELECT * FROM petitions WHERE id = ?`, [id]);
}

export async function listOpenPetitions(limit = 50, offset = 0): Promise<PetitionRow[]> {
  return all<PetitionRow>(
    `SELECT * FROM petitions
     WHERE status IN ('open', 'locked', 'finalizing')
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
    [limit, offset],
  );
}

export async function findOpenPetitionBySymbol(
  symbol: string,
  starterWallet?: string,
): Promise<PetitionRow | undefined> {
  const sym = normalizeCatalogTickerSymbol(symbol);
  if (starterWallet?.trim()) {
    let wallet = starterWallet.trim();
    try {
      wallet = getAddress(wallet);
    } catch {
      /* keep raw */
    }
    return get<PetitionRow>(
      `SELECT * FROM petitions
       WHERE status = 'open' AND token_symbol = ? AND starter_wallet = ?
       ORDER BY id DESC LIMIT 1`,
      [sym, wallet],
    );
  }
  return get<PetitionRow>(
    `SELECT * FROM petitions WHERE status = 'open' AND token_symbol = ? ORDER BY id DESC LIMIT 1`,
    [sym],
  );
}

function activeStatusPlaceholders(): string {
  return ACTIVE_COMMUNITY_LAUNCH_STATUSES.map(() => '?').join(', ');
}

/** Active community launch reserving this ticker (open, sold-out finalizing, etc.). */
export async function findActiveCommunityLaunchBySymbol(
  symbol: string,
): Promise<PetitionRow | undefined> {
  const sym = normalizeCatalogTickerSymbol(symbol);
  if (!sym) return undefined;
  return get<PetitionRow>(
    `SELECT * FROM petitions
     WHERE status IN (${activeStatusPlaceholders()}) AND token_symbol = ?
     ORDER BY id DESC LIMIT 1`,
    [...ACTIVE_COMMUNITY_LAUNCH_STATUSES, sym],
  );
}

/** Active community launch reserving this token name (case-insensitive). */
export async function findActiveCommunityLaunchByName(
  name: string,
): Promise<PetitionRow | undefined> {
  const normalized = normalizeCatalogTokenName(name);
  if (normalized.length < 2) return undefined;
  return get<PetitionRow>(
    `SELECT * FROM petitions
     WHERE status IN (${activeStatusPlaceholders()})
       AND lower(trim(token_name)) = ?
     ORDER BY id DESC LIMIT 1`,
    [...ACTIVE_COMMUNITY_LAUNCH_STATUSES, normalized],
  );
}

export async function listPetitionOrders(petitionId: number): Promise<PetitionOrderRow[]> {
  return all<PetitionOrderRow>(
    `SELECT * FROM petition_orders WHERE petition_id = ? ORDER BY created_at ASC`,
    [petitionId],
  );
}

export async function getPetitionOrder(
  petitionId: number,
  wallet: string,
): Promise<PetitionOrderRow | undefined> {
  const w = getAddress(wallet);
  return get<PetitionOrderRow>(
    `SELECT * FROM petition_orders WHERE petition_id = ? AND wallet = ?`,
    [petitionId, w],
  );
}

export async function refreshPetitionExpiryStatus(petition: PetitionRow): Promise<PetitionRow> {
  if (petition.status !== 'open') return petition;
  if (new Date(petition.expires_at).getTime() > Date.now()) return petition;
  await run(`UPDATE petitions SET status = 'expired' WHERE id = ? AND status = 'open'`, [
    petition.id,
  ]);
  return (await getPetitionById(petition.id)) ?? petition;
}

export async function updatePetitionSoldUnits(petitionId: number, soldUnits: number): Promise<void> {
  await run(`UPDATE petitions SET sold_units = ? WHERE id = ?`, [soldUnits, petitionId]);
}

export async function updatePetitionImageUrl(petitionId: number, imageUrl: string): Promise<void> {
  const url = imageUrl.trim().slice(0, 1024);
  if (!url) return;
  await run(
    `UPDATE petitions SET image_url = ? WHERE id = ? AND (image_url IS NULL OR image_url = '')`,
    [url, petitionId],
  );
}

export async function markPetitionLocked(petitionId: number): Promise<void> {
  await run(`UPDATE petitions SET status = 'locked' WHERE id = ? AND status = 'open'`, [petitionId]);
}

export async function markPetitionFinalizing(petitionId: number): Promise<void> {
  await run(`UPDATE petitions SET status = 'finalizing' WHERE id = ?`, [petitionId]);
}

export async function markPetitionFinalized(
  petitionId: number,
  input: { tokenAddress: string; deployTxHash: string; airdropTxHash?: string },
): Promise<void> {
  await run(
    `UPDATE petitions SET
      status = 'finalized',
      token_address = ?,
      deploy_tx_hash = ?,
      airdrop_tx_hash = ?,
      final_error = ''
     WHERE id = ?`,
    [
      input.tokenAddress,
      input.deployTxHash,
      input.airdropTxHash ?? '',
      petitionId,
    ],
  );
}

export async function markPetitionFailed(petitionId: number, error: string): Promise<void> {
  await run(`UPDATE petitions SET status = 'failed', final_error = ? WHERE id = ?`, [
    error.slice(0, 2000),
    petitionId,
  ]);
}

export async function markPetitionCancelled(petitionId: number): Promise<boolean> {
  await run(`UPDATE petitions SET status = 'cancelled' WHERE id = ? AND status IN ('open', 'expired')`, [
    petitionId,
  ]);
  const row = await getPetitionById(petitionId);
  return row?.status === 'cancelled';
}

export async function insertPetitionOrder(input: {
  petitionId: number;
  wallet: string;
  units: number;
  launchBuyWei: string;
  depositWei: string;
  depositTxHash: string;
}): Promise<PetitionOrderRow> {
  const wallet = getAddress(input.wallet);
  await run(
    `INSERT INTO petition_orders (
      petition_id, wallet, units, launch_buy_wei, deposit_wei, deposit_tx_hash, status
    ) VALUES (?, ?, ?, ?, ?, ?, 'active')
    ON CONFLICT(petition_id, wallet) DO UPDATE SET
      units = excluded.units,
      launch_buy_wei = excluded.launch_buy_wei,
      deposit_wei = excluded.deposit_wei,
      deposit_tx_hash = excluded.deposit_tx_hash,
      status = 'active',
      refunded_at = NULL`,
    [
      input.petitionId,
      wallet,
      input.units,
      input.launchBuyWei,
      input.depositWei,
      input.depositTxHash,
    ],
  );
  const row = await getPetitionOrder(input.petitionId, wallet);
  if (!row) throw new Error('Failed to record petition order');
  return row;
}

export async function markOrderRefunded(petitionId: number, wallet: string): Promise<void> {
  const w = getAddress(wallet);
  await run(
    `UPDATE petition_orders SET status = 'refunded', refunded_at = CURRENT_TIMESTAMP
     WHERE petition_id = ? AND wallet = ?`,
    [petitionId, w],
  );
}

export async function sumActiveRaisedWei(petitionId: number): Promise<bigint> {
  const orders = await all<PetitionOrderRow>(
    `SELECT * FROM petition_orders WHERE petition_id = ? AND status = 'active'`,
    [petitionId],
  );
  return orders.reduce((sum, o) => sum + BigInt(o.deposit_wei || '0'), 0n);
}

export async function sumActiveSoldUnits(petitionId: number): Promise<number> {
  const row = await get<{ total: number }>(
    `SELECT COALESCE(SUM(units), 0) AS total FROM petition_orders
     WHERE petition_id = ? AND status = 'active'`,
    [petitionId],
  );
  return Number(row?.total ?? 0);
}
