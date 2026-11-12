/**
 * PoC shim: faithful port of the real lib/petitionDb.ts API onto `node:sqlite`
 * (the original uses the native `sqlite3` package which needs a node-gyp build).
 * SQL statements are copied verbatim from the audited source.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { getAddress } from 'viem';
import { logger } from '../logger.js';
import { petitionOpenDurationMs } from './petitionConfig.js';
import { normalizeCatalogTokenName, normalizeCatalogTickerSymbol } from './deploymentCatalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '../../.data');
const dbPath = path.join(dataDir, 'petition.db');

let db: DatabaseSync | null = null;

export type PetitionStatus =
  | 'open' | 'locked' | 'finalizing' | 'finalized' | 'failed' | 'expired' | 'cancelled';

export const ACTIVE_COMMUNITY_LAUNCH_STATUSES: PetitionStatus[] = ['open', 'locked', 'finalizing'];

export type PetitionRow = {
  id: number; created_at: string; expires_at: string; status: PetitionStatus;
  token_name: string; token_symbol: string; description: string; image_url: string;
  website_url: string; tweet_url: string; starter_wallet: string;
  max_units_per_wallet: number; supporter_slots: number | null; units_per_supporter: number | null;
  hood_claim_opt_in: number; goal_units: number; target_raise_wei: string; sold_units: number;
  token_address: string; deploy_tx_hash: string; airdrop_tx_hash: string; final_error: string;
  source_url: string;
};

export type PetitionOrderRow = {
  id: number; petition_id: number; wallet: string; units: number; launch_buy_wei: string;
  deposit_wei: string; deposit_tx_hash: string; status: string; created_at: string;
  refunded_at: string | null;
};

function run(sql: string, params: unknown[] = []): void {
  if (!db) throw new Error('petition DB not initialized');
  db.prepare(sql).run(...(params as never[]));
}
function get<T>(sql: string, params: unknown[] = []): T | undefined {
  if (!db) throw new Error('petition DB not initialized');
  return db.prepare(sql).get(...(params as never[])) as T | undefined;
}
function all<T>(sql: string, params: unknown[] = []): T[] {
  if (!db) throw new Error('petition DB not initialized');
  return db.prepare(sql).all(...(params as never[])) as T[];
}
const tick = () => new Promise((r) => setTimeout(r, 0));

export function initPetitionDb(): void {
  if (db) return;
  mkdirSync(dataDir, { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS petitions (
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
        max_units_per_wallet INTEGER NOT NULL DEFAULT 1,
        supporter_slots INTEGER,
        units_per_supporter INTEGER,
        hood_claim_opt_in INTEGER NOT NULL DEFAULT 0,
        goal_units INTEGER NOT NULL DEFAULT 1000,
        sold_units INTEGER NOT NULL DEFAULT 0,
        token_address TEXT NOT NULL DEFAULT '',
        deploy_tx_hash TEXT NOT NULL DEFAULT '',
        airdrop_tx_hash TEXT NOT NULL DEFAULT '',
        final_error TEXT NOT NULL DEFAULT '',
        source_url TEXT NOT NULL DEFAULT ''
      )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_petitions_status ON petitions(status, created_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_petitions_symbol ON petitions(token_symbol, status)`);
  db.exec(`CREATE TABLE IF NOT EXISTS petition_orders (
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
        UNIQUE(petition_id, wallet)
      )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_petition_orders_petition ON petition_orders(petition_id, status)`);
  db.exec(`ALTER TABLE petitions ADD COLUMN target_raise_wei TEXT NOT NULL DEFAULT '0'`);
  logger.info('Petition DB ready:', dbPath);
}

export function closePetitionDb(): void { db?.close(); db = null; }
export function petitionDbReady(): boolean { return db != null; }

export async function createPetition(input: {
  tokenName: string; tokenSymbol: string; description?: string; imageUrl?: string;
  websiteUrl?: string; tweetUrl?: string; starterWallet?: string; maxUnitsPerWallet: number;
  supporterSlots?: number; unitsPerSupporter?: number; hoodClaimOptIn?: boolean;
  goalUnits?: number; targetRaiseWei: string;
}): Promise<PetitionRow> {
  const expiresAt = new Date(Date.now() + petitionOpenDurationMs()).toISOString();
  let starter = '';
  if (input.starterWallet?.trim()) {
    try { starter = getAddress(input.starterWallet.trim()); }
    catch { starter = input.starterWallet.trim().slice(0, 42); }
  }
  run(`INSERT INTO petitions (
      expires_at, token_name, token_symbol, description, image_url, website_url, tweet_url,
      starter_wallet, max_units_per_wallet, supporter_slots, units_per_supporter,
      hood_claim_opt_in, goal_units, target_raise_wei
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    expiresAt, input.tokenName.slice(0, 64), input.tokenSymbol.slice(0, 16),
    (input.description ?? '').slice(0, 2000), (input.imageUrl ?? '').slice(0, 1024),
    (input.websiteUrl ?? '').slice(0, 1024), (input.tweetUrl ?? '').slice(0, 1024),
    starter, input.maxUnitsPerWallet, input.supporterSlots ?? null,
    input.unitsPerSupporter ?? null, input.hoodClaimOptIn ? 1 : 0,
    input.goalUnits ?? 1000, input.targetRaiseWei,
  ]);
  await tick();
  const row = get<PetitionRow>(`SELECT * FROM petitions ORDER BY id DESC LIMIT 1`);
  if (!row) throw new Error('Failed to create petition');
  return row;
}

export async function getPetitionById(id: number): Promise<PetitionRow | undefined> {
  await tick();
  return get<PetitionRow>(`SELECT * FROM petitions WHERE id = ?`, [id]);
}

export async function listOpenPetitions(limit = 50, offset = 0): Promise<PetitionRow[]> {
  await tick();
  return all<PetitionRow>(`SELECT * FROM petitions
     WHERE status IN ('open', 'locked', 'finalizing')
     ORDER BY created_at DESC LIMIT ? OFFSET ?`, [limit, offset]);
}

export async function findOpenPetitionBySymbol(symbol: string, starterWallet?: string) {
  const sym = normalizeCatalogTickerSymbol(symbol);
  await tick();
  if (starterWallet?.trim()) {
    let wallet = starterWallet.trim();
    try { wallet = getAddress(wallet); } catch { /* keep raw */ }
    return get<PetitionRow>(`SELECT * FROM petitions
       WHERE status = 'open' AND token_symbol = ? AND starter_wallet = ?
       ORDER BY id DESC LIMIT 1`, [sym, wallet]);
  }
  return get<PetitionRow>(`SELECT * FROM petitions WHERE status = 'open' AND token_symbol = ?
     ORDER BY id DESC LIMIT 1`, [sym]);
}

const ph = () => ACTIVE_COMMUNITY_LAUNCH_STATUSES.map(() => '?').join(', ');

export async function findActiveCommunityLaunchBySymbol(symbol: string) {
  const sym = normalizeCatalogTickerSymbol(symbol);
  if (!sym) return undefined;
  await tick();
  return get<PetitionRow>(`SELECT * FROM petitions
     WHERE status IN (${ph()}) AND token_symbol = ? ORDER BY id DESC LIMIT 1`,
    [...ACTIVE_COMMUNITY_LAUNCH_STATUSES, sym]);
}

export async function findActiveCommunityLaunchByName(name: string) {
  const normalized = normalizeCatalogTokenName(name);
  if (normalized.length < 2) return undefined;
  await tick();
  return get<PetitionRow>(`SELECT * FROM petitions
     WHERE status IN (${ph()}) AND lower(trim(token_name)) = ? ORDER BY id DESC LIMIT 1`,
    [...ACTIVE_COMMUNITY_LAUNCH_STATUSES, normalized]);
}

export async function listPetitionOrders(petitionId: number): Promise<PetitionOrderRow[]> {
  await tick();
  return all<PetitionOrderRow>(
    `SELECT * FROM petition_orders WHERE petition_id = ? ORDER BY created_at ASC`, [petitionId]);
}

export async function getPetitionOrder(petitionId: number, wallet: string) {
  const w = getAddress(wallet);
  await tick();
  return get<PetitionOrderRow>(
    `SELECT * FROM petition_orders WHERE petition_id = ? AND wallet = ?`, [petitionId, w]);
}

export async function refreshPetitionExpiryStatus(petition: PetitionRow): Promise<PetitionRow> {
  if (petition.status !== 'open') return petition;
  if (new Date(petition.expires_at).getTime() > Date.now()) return petition;
  await tick();
  run(`UPDATE petitions SET status = 'expired' WHERE id = ? AND status = 'open'`, [petition.id]);
  return (await getPetitionById(petition.id)) ?? petition;
}

export async function updatePetitionImageUrl(petitionId: number, imageUrl: string) {
  await tick();
  run(`UPDATE petitions SET image_url = ? WHERE id = ?`, [imageUrl, petitionId]);
}

export async function updatePetitionSoldUnits(petitionId: number, soldUnits: number) {
  await tick();
  run(`UPDATE petitions SET sold_units = ? WHERE id = ?`, [soldUnits, petitionId]);
}

export async function markPetitionLocked(petitionId: number) {
  await tick();
  run(`UPDATE petitions SET status = 'locked' WHERE id = ? AND status = 'open'`, [petitionId]);
}
export async function markPetitionFinalizing(petitionId: number) {
  await tick();
  run(`UPDATE petitions SET status = 'finalizing' WHERE id = ?`, [petitionId]);
}
export async function markPetitionFinalized(petitionId: number, r: {
  tokenAddress: string; deployTxHash: string; airdropTxHash?: string;
}) {
  await tick();
  run(`UPDATE petitions SET status = 'finalized', token_address = ?, deploy_tx_hash = ?,
       airdrop_tx_hash = ? WHERE id = ?`,
    [r.tokenAddress, r.deployTxHash, r.airdropTxHash ?? '', petitionId]);
}
export async function markPetitionFailed(petitionId: number, error: string) {
  await tick();
  run(`UPDATE petitions SET status = 'failed', final_error = ? WHERE id = ?`, [error, petitionId]);
}
export async function markPetitionCancelled(petitionId: number): Promise<boolean> {
  await tick();
  run(`UPDATE petitions SET status = 'cancelled' WHERE id = ? AND status IN ('open', 'expired')`,
    [petitionId]);
  const row = await getPetitionById(petitionId);
  return row?.status === 'cancelled';
}

export async function insertPetitionOrder(input: {
  petitionId: number; wallet: string; units: number; launchBuyWei: string;
  depositWei: string; depositTxHash: string;
}): Promise<PetitionOrderRow> {
  const wallet = getAddress(input.wallet);
  await tick();
  run(`INSERT INTO petition_orders (
      petition_id, wallet, units, launch_buy_wei, deposit_wei, deposit_tx_hash, status
    ) VALUES (?, ?, ?, ?, ?, ?, 'active')
    ON CONFLICT(petition_id, wallet) DO UPDATE SET
      units = excluded.units,
      launch_buy_wei = excluded.launch_buy_wei,
      deposit_wei = excluded.deposit_wei,
      deposit_tx_hash = excluded.deposit_tx_hash,
      status = 'active',
      refunded_at = NULL`,
    [input.petitionId, wallet, input.units, input.launchBuyWei, input.depositWei,
      input.depositTxHash]);
  const row = await getPetitionOrder(input.petitionId, wallet);
  if (!row) throw new Error('Failed to record petition order');
  return row;
}

export async function markOrderRefunded(petitionId: number, wallet: string) {
  const w = getAddress(wallet);
  await tick();
  run(`UPDATE petition_orders SET status = 'refunded', refunded_at = CURRENT_TIMESTAMP
     WHERE petition_id = ? AND wallet = ?`, [petitionId, w]);
}

export async function sumActiveRaisedWei(petitionId: number): Promise<bigint> {
  await tick();
  const orders = all<PetitionOrderRow>(
    `SELECT * FROM petition_orders WHERE petition_id = ? AND status = 'active'`, [petitionId]);
  return orders.reduce((s, o) => s + BigInt(o.deposit_wei || '0'), 0n);
}

export async function sumActiveSoldUnits(petitionId: number): Promise<number> {
  await tick();
  const row = get<{ total: number }>(`SELECT COALESCE(SUM(units), 0) AS total FROM petition_orders
     WHERE petition_id = ? AND status = 'active'`, [petitionId]);
  return Number(row?.total ?? 0);
}
