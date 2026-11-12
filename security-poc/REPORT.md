# Auditoría ofensiva Hood-Market — registro de alcance, repos y verificaciones

**Fecha:** 2026-11-12 · **Rama de trabajo:** `arena/8c5231e9-hood-market` (base `cf1bc022979c5001050ac5c8a0d200e6086ccc42`)

## 1. Inventario de repositorios (obligatorio, previo a cualquier hallazgo)

| Repo | Visibilidad | Commit / tag exacto | Uso en la auditoría |
|---|---|---|---|
| `hoodmarkets/Hood-Market` | público | `cf1bc022979c5001050ac5c8a0d200e6086ccc42` (rama `main`, release de código `c4f57bc`); verificado también con clon **no shallow** (`--filter=blob:none`, historia completa = 2 commits) | repo auditado (contracts + api + docs) |
| `hoodmarkets/Hood-Market-Skill` | público | `310a71c` | documentación/agents, sin código desplegable |
| `hoodmarkets/*` (organización) | — | `GET /orgs/hoodmarkets/repos` → **404** (no existe la org); `GET /users/hoodmarkets/repos` → 2 repos | no hay más superficie pública |
| `clanker-devco/v4-contracts` | público | clon `2025-11-07` | upstream del stack V4/pro (diff por tokens) |
| `clanker-devco/v3.1-contracts` | público | clon `2025-08-12` | upstream del stack V3 (`src/v31`) |
| `anondevv69/hoodmarkets` | público (fork de tercero) | `c79fae8` | contiene `src/fees/` extra; **no** es código en producción del repo auditado |
| `AntFleet/wstdiem` | público, **pre-producción** (`v0.1.0-rc1`, "Pre-production... undergoing external audit") | HEAD del 2026-08-22 | el stack wstDIEM **desplegado en Base no corresponde a este repo** → se descartó como fuente de producción |

**BLOQUEADOS:** no existen repos privados accesibles ni referenciados por el repo auditado
(no hay `.gitmodules`, `contracts/lib/*` está vacío y `git submodule status` devuelve error).
Por tanto **no** se puede afirmar cobertura de "repos privados": se declara explícitamente que la cobertura se
limita a los repos públicos listados. El código del front (`hood.markets`) y el del bot no están publicados →
**BLOQUEADOS** (sólo su contrato de API es auditable, vía `api/src`).

## 2. Diff contra upstream (dónde está la superficie nueva real)

* **V4 / "pro"**: `HoodMarkets.sol`, `HoodMarketsHookV2`, `LpLockerFeeConversion`, `SniperAuctionV2`,
  `HookDynamicFeeV2`, `HookStaticFeeV2`, `MevDescendingFees`, `SniperUtilV2`, `Univ4EthDevBuy`, `AirdropV2`,
  `PresaleEthToCreator`, `LiquidVault`, `StakingVault` → diff por **tokens** contra `clanker/v4-contracts`:
  sólo `PROTOCOL`, el banner ASCII y renombres `clanker|Liquid → HoodMarkets`. **Sin lógica nueva.**
  Conclusión: hereda la superficie ya auditada por 0xMacro/Cantina; no se re-audita desde cero.
* **V3 / `simple`**: `HoodMarketsV3LpLocker` (similitud 0.992), `HoodMarketsV3Vault` (0.983),
  `HoodMarketsV3Deployer` (0.94) ≈ upstream `v3.1-contracts`. `HoodMarketsV3` (0.84) y `HoodMarketsV3Token`
  (0.77) divergen por: **sistema de fractions** (`FRACTION_COUNT=1000`, `FRACTION_VAULT_PERCENTAGE=10`),
  `configureFeeRewards`, `issueBuyerShare`, `setBuyerRewardRelay`, `fractionCollectionForToken`, y la
  eliminación del import de `IERC7802` (el token de este fork **no** es superchain-bridgeable).
  → **Ésta es la superficie nueva real.**

## 3. Estado de la capa on-chain V3 (`contracts/src/v31`)

Ejecutado con EVM real (ganache local, `evmVersion: shanghai`, `viaIR` desactivado en el arnés) más
`@ethereumjs/vm` para escenarios que requieren `msg.sender == contrato`:

| Escenario ejecutado | Resultado |
|---|---|
| Deploy + `initialize` de `HoodMarketsV3TokenFraction` con `vaultAmount = supply/10`, `FRACTION_COUNT=1000` | `tokensPerFraction = 1e25`, `outstandingShares = 1000`; requiere `balanceOf(fraction) >= vaultAmount` ✔ |
| `configureFeeRewards` (sólo `msg.sender == hoodMarketsFactory`) | impersonado; redirect de creator fees a la fraction ✔ |
| Acumulación de fees en el token pareado (`WETH`) 10 ETH → `claimTradingFees` | `pendingTradingFees` = 10 ETH; pago exacto al creator; `rewardTokenAccounted` vuelve a 0 ✔ |
| Segundo ciclo de 10 ETH | reparto correcto, sin doble conteo (`accRewardPerShare` en 1e18, `_feeEligibleShares()` = `outstandingShares − escrow`) ✔ |
| `airdropShares` (usado por `petitionFinalize.ts:200-221`) | sólo transfiere shares existentes; **no** mintea ni infla `outstandingShares`; `_syncRewardDebt` del emisor evita arrastrar deuda ✔ |
| `_rewardableBalance` para el `launchToken` | descuenta `outstandingShares * tokensPerFraction` → los tokens del vault no se reparten como fees ✔ |

**Invariantes verificadas (no violadas):**
1. `sum(balanceOf(share)) == outstandingShares` en todo momento (no hay mint de shares fuera de `initialize`).
2. `accRewardPerShare` sólo crece y `rewardTokenAccounted ≤ _rewardableBalance` ⇒ no se paga dos veces el mismo fee.
3. `redeem` quema shares y baja `outstandingShares` antes de transferir el subyacente (CEI + `nonReentrant`).
4. Marketplace `buyShares`: el 5 % va a `shareSalePlatformFeeRecipient()` y el 95 % al vendedor, sin tocar el principal.
5. Nadie puede llamar `claimTradingFees` en nombre de otro para robarle el pendiente (`_payoutRewardToken` paga a `msg.sender`/`account` correcto).

**Conclusión de la capa on-chain V3: no crítico en código.** Lo único llamativo (`claimTradingFees` O(n) sobre
holders, `_pendingWithUnaccounted` con coste O(1)) es DoS por gas *auto-infligido*: no hay beneficio para un
tercero y el emisor paga su propio gas → descartado por la regla "self-grief".

## 4. Descartados explícitamente (con motivo)

| Candidato | Por qué NO es crítico |
|---|---|
| `src/v31/HoodMarketsPetitionEscrow.sol` — `finalize()` barre `address(this).balance` completo (cross-petition) | el contrato **no está referenciado** por la API ni por ningún script de despliegue; la API custodia en una EOA. Código muerto para el flujo real. |
| Mismo contrato — `unitPriceWei` fijo vs. contribución libre de la API | la API no lo usa (`requiredDepositWei(contributionWei) = contributionWei`). |
| `MevDescendingFees` / `SniperAuctionV2` | idénticos al upstream auditado; parámetros (`MIN_BASE_FEE=2500`, `paymentPerGasUnit=1e-4 ether`) sólo afectan al sniper que paga. |
| `FeeRouter.harvest()` / `LpLockerFeeConversion._uniSwapLocked` con `amountOutMinimum: 0` | sandwich *posible* pero permissionless sólo dentro del mismo bloque; requiere ser builder/searcher con inclusión ordenada y el beneficio sale de fees del pool, no de un principal de usuario; **no** cumple "tercero sin privilegios hoy" sin control de ordering. Se deja como observación (MEV), no como crítico. |
| `router/adapters` de `vault/*` (wstDIEM v6) | el código del despliegue en Base **no está en ningún repo público** (el único repo `wstdiem` es pre-producción) → no auditable desde código; se documenta como **BLOQUEADO**, no como hallazgo. |
| `agentClaimForRecipient.ts`, `walletAuth.ts`, `webWalletChallenge.ts` | challenge con nonce de 16 bytes, TTL 5 min, consumo de un solo uso y `verifyMessage` contra la dirección → sin replay ni suplantación. |
| `config.ts` con `DEPLOYER_PRIVATE_KEY` | custodia de clave (riesgo operativo/centralización), no vulnerabilidad permissionless explotable por un tercero sin la clave. |

## 5. Reproducir el PoC del Hallazgo #1

Ver `FINDING-01-community-launch-refund-replay.md` §3 (comandos exactos y transcripción).
Artefactos en esta carpeta:

* `poc_escrow.mjs` — PoC end-to-end (fases 0-3).
* `petitionDb.nodesqlite.ts` — port de `api/src/lib/petitionDb.ts` a `node:sqlite` (SQL idéntico).
* `petitionDb.original.ts` — original sin tocar, para el diff.
* `sqlite3-shim/` — `node_modules/sqlite3` de reemplazo (misma API callback) para no compilar nativo.
