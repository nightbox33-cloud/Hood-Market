# Auditoría ofensiva Hood-Market — Hallazgo #1 (CRÍTICO)

**Fecha:** 2026-11-12 · **Repo:** `hoodmarkets/Hood-Market` · **Commit auditado:** `cf1bc022979c5001050ac5c8a0d200e6086ccc42`
(rama `main`, único commit de código: `c4f57bc` "Initial public release: contracts, API, and docs.")
**Componente:** API off-chain `api.hood.markets` — rail **Community Launch** (preventa de tickers en Robinhood Chain 4663)
**Clase:** replay / falta de binding tx↔orden + custodia en EOA + estado no atómico → **robo directo de ETH de terceros**

---

## 0. Resumen para decisión

Un atacante sin privilegios, sin capital semilla y sin interacción con ningún contrato puede:

1. abrir un "Community Launch" a nombre de cualquier ticker (p. ej. `ANTHROPIC`), apareciendo él mismo como
   `starter_wallet` → **futuro receptor de las trading fees del token** cuando el round se finaliza;
2. depositar ETH, llamar `POST /refund` (cobrar) y luego `POST /confirm` con **el mismo hash de transacción ya
   liquidado** para que el sistema lo vuelva a acreditar; repetir el ciclo. Cada ciclo **paga ETH real de la
   tesorería del escrow**, que es la suma de los depósitos de todos los backers del round;
3. quedarse con el **100 % de lo recaudado**: los backers legítimos ya no pueden retirar (el escrow queda corto y
   la ruta `/refund` revienta sin responder, dejando además un *unhandled rejection* que mata el proceso Node).

El PoC ejecuta el código **real** del repo (handlers Express, módulos de refund y SQL de la DB) contra un EVM local
(`chainId 4663`) y muestra PnL positivo del atacante pagado con fondos de las víctimas.

---

## 1. Ubicación exacta

| # | Archivo | Líneas | Qué hace mal |
|---|---------|--------|--------------|
| A | `api/src/routes/communityLaunch.ts` | **340-419** (`POST /api/community-launch/confirm`) | re-acepta un `signature` (tx hash) ya usado y ya reembolsado |
| B | `api/src/routes/communityLaunch.ts` | **371-373** | sólo bloquea el *re-confirm* si la orden previa sigue `active` **y** el hash difiere → una orden `refunded` se salta el chequeo |
| C | `api/src/lib/petitionRobinhoodEscrow.ts` | **35-82** (`verifyPetitionDeposit`) | valida `from`, `to`, `status` y `value` de la tx, **nunca** que el hash no haya sido consumido antes; no consulta `orders.deposit_tx_hash` ni el contrato |
| D | `api/src/lib/petitionDb.ts` | **399-431** (`insertPetitionOrder`) | `ON CONFLICT(petition_id, wallet) DO UPDATE ... status = 'active', refunded_at = NULL` reactiva una orden reembolsada |
| E | `api/src/lib/petitionConfig.ts` | **23-27** (`petitionEscrowAddress`) | el "escrow" es **la EOA del `DEPLOYER_PRIVATE_KEY`**, no un contrato: los depósitos y el gas de operación comparten la misma cuenta |
| F | `api/src/lib/petitionRefunds.ts` | **13-25, 27-41** | los reembolsos los firma esa misma EOA (`privateKeyToAccount(config.deployerPrivateKey)`), sin límite por orden ni contabilidad on-chain |
| G | `api/src/routes/communityLaunch.ts` | **421-470** (`POST /refund`) | no es atómico con `/confirm`; entre el `getPetitionOrder` y el `markOrderRefunded` hay espera de red → carrera de doble cobro |
| H | `api/src/routes/communityLaunch.ts` | **457** | `await refundPetitionOrder(...)` sin `try/catch` → Express 4 no captura rechazos: la petición nunca responde y Node 22 tumba el proceso |
| I | `api/src/petitionEthGoal.ts` | **106-133** (`validateEthContribution`) + `routes/communityLaunch.ts` **174-230** (`/create`) | el chequeo de "slots" es *check-then-act* sobre la DB y se re-ejecuta sólo en `/prepare-deposit`; `/confirm` lo revalida con datos ya obsoletos → sobre-suscripción del objetivo |

Todos los ficheros pertenecen al repo y commit indicados; no hay submódulos ni código generado en esta ruta.

---

## 2. El bug, paso a paso

### 2.1 Estado de una orden
`petition_orders` tiene `UNIQUE(petition_id, wallet)` y una columna `status` (`active` | `refunded`).
`markOrderRefunded()` pone `status='refunded'`. `insertPetitionOrder()` hace
`ON CONFLICT(petition_id, wallet) DO UPDATE SET ... status='active', refunded_at=NULL` — es decir,
**el mismo registro se puede reactivar**, y `deposit_wei` / `deposit_tx_hash` se *sobrescriben* con lo que manda el
cliente.

### 2.2 Qué cambia entre refund y confirm
```
POST /refund   → getPetitionOrder(id, wallet)  (status='active')
               → refundPetitionOrder(): la EOA del deployer envía order.deposit_wei a la wallet
               → markOrderRefunded(): UPDATE status='refunded'
               → updatePetitionSoldUnits(id, 0)

POST /confirm  → existing = getPetitionOrder(id, wallet)         // ahora 'refunded'
               → if (existing?.status === 'active' && existing.deposit_tx_hash !== signature) revert
                 // ↑ 'refunded' ⇒ NO entra en el if, el chequeo desaparece
               → verifyPetitionDeposit(): lee la tx on-chain: from = wallet ✔, to = escrow ✔,
                 status = success ✔, value ≥ pedido ✔   // NO mira si esa tx ya se usó
               → insertPetitionOrder(): UPSERT → status='active', deposit_wei = verified.wei
               → updatePetitionSoldUnits(id, 0)
```
`/confirm` es, por diseño, una **declaración** ("he depositado en esta tx") sin nonce ni consumo del hash.
Como el hash de una tx es público, se puede reenviar infinitamente.

### 2.3 Por qué el dinero sale de terceros
El saldo que paga `/refund` es `address(this)` de la EOA-escrow, que contiene:
`depósitos de todos los backers de todos los rounds + float de gas del deployer`.
No hay contabilidad on-chain por orden: el backend acredita según su tabla SQLite. Al inflar la tabla sin fondos
detrás, los reembolsos de las víctimas se pagan con **los depósitos de los demás** hasta agotarlos
(exactamente lo que muestra la fase 3 del PoC).

### 2.4 Contexto que agrava (y que convierte esto en robo, no en self-grief)
* `POST /create` **no autentica** (`routes/communityLaunch.ts:174-230`): cualquiera elige ticker, nombre, objetivo
  y `starterWallet`. El `starter_wallet` es el `feeRecipient` del token en `petitionFinalize.ts:164,173`.
* Un round `open|locked|finalizing` **reserva el ticker a nivel de protocolo** (`communityLaunchLock.ts:39-62`,
  consultado en `deployWeb.ts` y `agentDeployPreflight.ts`), es decir: gratis se puede bloquear un ticker ajeno.
* El escrow es la EOA del deployer (`petitionConfig.ts:23-27`) y esa misma clave firma reembolsos, despliegues y
  dev-buys → **un solo saldo** donde conviven dinero de usuarios y gas de operación. Cualquier desvío deja al
  sistema sin gas para pagar reembolsos.

---

## 3. PoC reproducible

### 3.1 Requisitos
Node 22 (usa `node:sqlite`), sin RPC externo, sin fork, sin claves reales.

```bash
cd security-poc
# el arnés necesita el código real de la API; se monta junto al handler auditado:
mkdir -p ../poc-api && cp -r ../Hood-Market/api/src ../poc-api/ && cd ../poc-api
node -e "const p=require('../Hood-Market/api/package.json');delete p.dependencies.sqlite3;require('fs').writeFileSync('package.json',JSON.stringify(p,null,2))"
npm i --omit=dev --ignore-scripts --no-audit --no-fund   # + npm i ganache
# shim de sqlite3 (misma API callback) sobre node:sqlite:
cp -r ../security-poc/sqlite3-shim node_modules/sqlite3
cp ../security-poc/petitionDb.nodesqlite.ts src/lib/petitionDb.ts     # mismas SQL, mismo contrato de módulo
cp ../security-poc/poc_escrow.mjs .
npx tsx poc_escrow.mjs
```
El shim de `sqlite3` y el port de `petitionDb.ts` sólo cambian el driver (`sqlite3` nativo → `node:sqlite`);
**las sentencias SQL son idénticas** (`petitionDb.original.ts` va al lado para el diff).
Todo lo demás — `routes/communityLaunch.ts`, `petitionRefunds.ts`, `petitionRobinhoodEscrow.ts`,
`petitionEthGoal.ts`, `config.ts` — se ejecuta **sin modificar**.

### 3.2 Salida real (transcripción)

```
escrow EOA (== DEPLOYER_PRIVATE_KEY) : 0xDa7DF4182EfC17E01db8D96f0Fa619d9D830965A
attacker A / victim B / victim C     : 0x19E7…ff2A / 0x1563…915e / 0x5CbD…86a
operational float already in escrow  : 0.050000 ETH

=== 0. anonymous round creation (no auth, no stake, fee recipient = attacker) ===
POST /create -> 200 ok=true reused=false
round #1: target 0.400000 ETH / 4 slots (0.100000 ETH each), status open
starter_wallet (= fee recipient of the future token) = 0x19E7…ff2A
ticker ANTHROPIC is now reserved protocol-wide (deployWeb + agent preflight block it)

=== 1. non-atomic slot reservation ===
B /prepare-deposit -> ok=true   C /prepare-deposit -> ok=true  (both told to send 0.1 ETH)
B confirm -> 200 raised=0.100000   C confirm -> 200 raised=0.200000
escrow backer funds: 0.200000 ETH from 2 backers

=== 2. refund replay: /confirm accepts a deposit tx hash that was already refunded ===
A deposits 0.1 (tx 0x733fa9901f…) -> confirm 200 raised=0.300000
  cycle 1: /refund paid 0.1 ETH (A=9.999968) then /confirm replayed tx 0x733fa9901f… -> 200, raised=0.300000, escrow backer funds=0.199971
  cycle 2: /refund paid 0.1 ETH (A=10.099968) then /confirm replayed tx 0x733fa9901f… -> 200, raised=0.300000, escrow backer funds=0.099943
  attacker: deposited 0.1 ETH once, refund/replay cycles executed: 2
  attacker net PnL = +0.200000 ETH (funds taken from B and C)

=== 3. victim withdrawal now fails ===
  order 0x1563… status=active deposit=0.100000
  order 0x5CbD… status=active deposit=0.100000
  order 0x19E7… status=active deposit=0.100000
B /refund -> 200 (victim B is paid out of what is left)
C /refund -> NO_RESPONSE (handler never replied) — escrow is short, refundPetitionDeposit throws, Express 4 never answers
  unhandled rejection raised at routes/communityLaunch.ts:457 -> Node 22 default policy kills the API process
C balance 9.899965 -> 9.899965 ETH: victim C's 0.1 ETH is unrecoverable
escrow backer funds: -0.000085 ETH but DB still reports raised=0.200000 ETH
```

Cada línea `cycle N` es una llamada HTTP real: **el atacante cobra 0.1 ETH y vuelve a quedar "acreditado" con la
misma tx**. El número de ciclos sólo está limitado por el saldo del escrow, y el escrow lo llenan las víctimas
(objetivo máximo por round: 50 ETH; ver `petitionEthGoal.ts:6`).

### 3.3 Trazado mínimo (sin ejecutar nada)
Con `deposit=0.1 ETH` y `unitPrice` irrelevante (el rail nuevo usa contribución libre):
```
estado inicial:  escrow = D (depósitos de terceros) + G (gas float)
A: deposit 0.1 → escrow = D + G + 0.1            · orden A = active(0.1, tx=H)
A: /refund   → escrow = D + G                    · orden A = refunded
A: /confirm(H) → (H válido on-chain, no consumido) orden A = active(0.1, tx=H) · escrow sin cambios
A: /refund   → escrow = D + G − 0.1              · A cobra 0.1 que NO depositó de nuevo
...
tras k ciclos: A ha extraído k·0.1 − 0.1 ETH de D
víctima B pide /refund → se paga con D restante
víctima C pide /refund → escrow insuficiente → excepción (ruta rota, proceso tumbado)
```
PnL del atacante = `k·0.1 − 0.1 − gas` > 0 con `k ≥ 2`; con `k` = floor(D/0.1) se lleva todo el round.
Coste de ataque: **0** (no hace falta depositar propio: el depósito inicial se recupera en el primer ciclo).

---

## 4. Condiciones de configuración que lo hacen explotable

| Condición | Valor real |
|---|---|
| `DEPLOYER_PRIVATE_KEY` presente (obligatorio en `config.ts:180`) | sí, en producción |
| Saldo del escrow ≥ 1 depósito (float de gas + depósitos de backers) | sí en cualquier round con ≥ 1 backer |
| `CHAIN_RPC_URL` accesible por el atacante (para leer la tx) | no necesario: el hash lo publica el propio backer o el explorador |
| Round en estado `open` con ≥ 1 slot libre | trivial: el atacante crea el round |
| Rate limit / captcha / auth en `/confirm` o `/refund` | **ninguno** (CORS `*`, sin middleware) |
| **Agua abajo** | cualquiera sea el TVL del round, el atacante extrae hasta `k` depósitos |

No depende de decimales, oráculos, slippage ni de ninguna integración externa: es contabilidad off-chain sin
binding criptográfico.

---

## 5. Falsos positivos descartados / límites honestos

* **No** es self-grief: las víctimas son terceros que depositaron ETH en el mismo escrow (fase 1 y 3 del PoC).
* **No** requiere rol privilegiado: `/create`, `/confirm` y `/refund` son públicos y sin auth.
* **No** es dust: el mínimo por contribución es 0.001 ETH (`petitionEthGoal.ts:7`) y el techo por round 50 ETH.
* **No** se apoya en código muerto: los tres handlers están registrados (`index.ts:258`) y las tablas existen.
* **Limitación honesta:** no hay RPC (restricción del encargo), por lo que **no** se afirma el TVL actual del
  escrow en 4663. El hallazgo es de lógica: la ruta está activa en el repo y el único requisito es que exista
  un depósito vivo. La fase 0 se ejecutó con el código tal cual; en producción el mismo `POST /create` está
  expuesto en `https://api.hood.markets/api/community-launch/create`.
* El contrato `contracts/src/v31/HoodMarketsPetitionEscrow.sol` **no** está referenciado por la API ni por los
  scripts de despliegue: ese escrow on-chain es código muerto en el flujo real (`sweep` cross-petition y
  `unitPriceWei` fijo no aplican), y por eso **no** se reporta como hallazgo.

---

## 6. Remediación sugerida (orden de urgencia)

1. **Inmediato:** deshabilitar `POST /confirm` (o el rail completo) mientras se corrige.
2. Tabla `petition_deposits(tx_hash PRIMARY KEY, petition_id, wallet, wei)` y **consumir el hash** en una
   transacción SQL; rechazar cualquier hash ya visto. El `ON CONFLICT ... status='active'` debe prohibirse.
3. `SELECT ... FOR UPDATE` / transacción atómica alrededor de `getPetitionOrder → pago → markOrderRefunded`
   (y un `refunds(tx_hash)` idempotente). Hoy hay ventana de red entre lectura y escritura (doble cobro).
4. Envolver el cuerpo de los handlers en `try/catch` (o `express-async-errors`): `routes/communityLaunch.ts:457`
   tumba el proceso.
5. Dejar de custodiar en la EOA del deployer: usar el `HoodMarketsPetitionEscrow` (o un escrow por round) y
   **contabilizar por orden on-chain**; separar el float de gas de los fondos de usuarios.
6. Autenticar `/create` (firma de `starterWallet` + coste anti-spam) para que nadie reserve tickers ajenos ni se
   auto-asigne el fee recipient.
