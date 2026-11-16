# SwapCircle

**Good trades come full circle.**

SwapCircle finds three-person CashTokens barter cycles and settles them in one
noncustodial Bitcoin Cash transaction.

Alice wants Bob's NFT. Bob wants Carol's. Carol wants Alice's. No pair can make the
trade they want, but the complete circle can.

## The problem and audience

Collectors in small CashTokens communities, clubs, and events can own an item
someone wants without owning the item their preferred counterparty wants. Buying
with BCH needs fresh funds; coordinating separate transfers requires trust; a
bilateral swap cannot clear the three-way mismatch.

SwapCircle is a focused trading primitive for those communities, not a general
NFT marketplace, investment product, or claim of established customer demand.
The MVP charges no platform fee. Community integrations and an explicitly
approved settlement fee are future business hypotheses, not current features.

## What works

- Wallet-derived inventory and off-chain offers, with category/commitment or exact
  outpoint wants.
- Deterministic three-way matching, shared live rooms, and exact asset, fee, and
  change review.
- External WizardConnect pairing and sparse partial signing. Spending keys never
  enter the production browser application or coordinator.
- Independent proposal validation against the original offer saved in the
  participant's browser.
- Three actual signatures aggregated into one consensus-verified CashTokens
  transaction.
- SQLite persistence, source verification through Electrum, input reservations,
  cancellation, signing-window expiry, signed-transaction export, and identical-byte
  broadcast recovery.
- Explicit Chipnet/Mainnet separation, mempool versus confirmation labels, and
  reorg-aware status refresh.
- Responsive interface and a five-slide presentation at `/#pitch`.

**Scope:** exactly three participants, P2PKH wallets, and immutable standalone
CashTokens NFTs. No mutable NFTs, minting rights, fungible balances, automatic
wallet discovery, AI dependencies, or escrow contracts. Generated token
identicons are original UI graphics, not collection artwork.

## Quick local demo, no real funds

Requires Node.js 22.18 or newer and npm.

```sh
npm ci
npm run demo
```

Open `http://127.0.0.1:4317` and its **Test wallets** link at `/demo`.

1. Connect the app to Alice's external test wallet by copying its pairing URI
   into the local test-wallet panel. Repeat with Bob and Carol in separate
   browser profiles.
2. Publish Alice's NFT for Bob's category, Bob's for Carol's, and Carol's for
   Alice's. The panel lists the actual generated category IDs. Every commitment
   is `01`.
3. Build the matching circle. Share its room link with the other two profiles,
   review each trade, and approve with each wallet.
4. Settle the circle. All three NFTs move together in the local ledger.

The Node-hosted test wallets generate fresh keys and actual Schnorr signatures.
They communicate through an encrypted local Nostr relay. The fixture ledger runs
the BCH virtual machine, rather than returning a canned settlement response.
Test wallets automatically approve signing requests after the app's review.

**These are synthetic local assets, not funded or minted Chipnet/Mainnet NFTs.**
Nothing is broadcast to a public chain. The demo binds only to `127.0.0.1` and
resets on restart. Its wallet controls live only in `e2e/server.ts`; they are not
part of the production server or container. Never expose the local demo publicly.
Private browser windows may share a session with each other. Separate profiles
give the clearest three-collector demo.

## Live-node development

```sh
cp .env.example .env
npm run dev
```

Open `http://127.0.0.1:5173`. Chipnet is the default. Mainnet requires a fresh,
explicit risk acknowledgement and wallet reconnection. No keys are created or
requested by the production application.

Use three supported wallet accounts with immutable NFTs and BCH for fees. The
default scan covers receive and change indexes 0 through 19, at most 40 addresses.
The wallet panel can scan another bounded range. It does not discover every
wallet account, path, or asset.

### Wallet compatibility is a release gate

The real WizardConnect libraries and encrypted transport have been verified with
external test wallet managers. This does **not** establish compatibility with
every released wallet.

A wallet must expose receive/change public derivation paths, support token-aware
P2PKH outputs and sparse partial signing, preserve the original transaction,
honor `broadcast: false`, and use
`SIGHASH_ALL | SIGHASH_FORKID | SIGHASH_UTXOS` (`0x61`). SwapCircle rejects weaker
or altered signatures. It does not fall back to unsafe flags.

Complete a funded Chipnet pilot with the exact wallet/version intended for the
submission before using low-value Mainnet assets. No physical third-party wallet
pilot or funded public-chain settlement has been performed for this build.

## Run a production build locally

```sh
npm run build
npm start
```

The compiled server serves both the UI and API. Do not serve the Vite output
alone. The coordinator requires Node's built-in SQLite support. Node 22 may print
an experimental SQLite warning.

| Variable                | Purpose                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `HOST`                  | Defaults to `127.0.0.1`; use `0.0.0.0` only when intentionally exposing the service.                                             |
| `PORT`                  | Defaults to `5173`.                                                                                                              |
| `DATA_DIR`              | Persistent coordinator directory, default `./data`.                                                                              |
| `PUBLIC_ORIGIN`         | Exact public HTTPS origin behind a reverse proxy, without a path. Enforces write origin and secure cookies. Leave blank locally. |
| `CHIPNET_ELECTRUM_HOST` | Chipnet node host, default `chipnet.bch.ninja`.                                                                                  |
| `MAINNET_ELECTRUM_HOST` | Mainnet node host, default `bch.imaginary.cash`.                                                                                 |
| `VITE_WIZARD_RELAYS`    | Optional comma-separated relay WebSocket URLs. Blank uses WizardConnect defaults.                                                |
| `VITE_PRIZE_ADDRESS`    | Owner-supplied Mainnet token-aware prize address, shown in the hackathon banner. Blank is visibly unconfigured.                  |

Despite the historical `VITE_` names, the two public settings are read by the
server at startup and delivered through `/api/config`. Restarting applies them;
no client rebuild is needed. Never put secrets, wallet seeds, or spending keys in
these settings.

Use one coordinator process per database. SQLite exclusive ownership is
intentional; this is not a horizontally scaled service. Preserve the entire data
directory, including SQLite WAL files. Stop the service before making a simple
file-copy backup, protect backups, and do not silently replace the database
during an unresolved broadcast. Browser session cookies and original-offer
storage are required to approve existing rooms; wallet connection alone does not
recover a lost browser session.

For public hosting, terminate TLS at a trusted reverse proxy, bind the backend
privately, set `PUBLIC_ORIGIN`, and use trusted Electrum infrastructure. The
application does not trust forwarded client-IP headers, so its 240-request/minute
limit is shared by clients behind one proxy. Add appropriate edge rate limiting
and capacity planning before a public community pilot. `/api/health` proves
coordinator readiness, not blockchain-node availability.

### Container

```sh
docker build -t swapcircle .
docker run --rm --name swapcircle \
  -p 127.0.0.1:5173:5173 \
  -v swapcircle-data:/app/data \
  --env-file .env \
  -e HOST=0.0.0.0 -e DATA_DIR=/app/data \
  swapcircle
```

The image runs as a non-root user and excludes test wallets and demo controls.
It binds `0.0.0.0` inside the container, while the example publishes only to host
loopback. Explicit `-e` values override development values from the provided
`.env` example. No production service has been deployed.

## Protocol and trust boundaries

Each offer identifies an exact NFT UTXO. Category and commitment are not globally
unique; requesting a listed item pins its exact outpoint. Distinct receiving
scripts are enforced, not distinct human identities.

One version-2 BCH transaction transfers the three NFTs, returns each participant's
change, and includes an `OP_RETURN` anchor `SC1:<circle UUID>`. The room anchor
prevents approvals being reused in another otherwise identical room. Each
signature commits to all inputs, source UTXOs, and exact outputs. The browser
derives its owned input scripts from wallet public keys and verifies the returned
partial signature; the coordinator validates every approval and the complete
transaction with the BCH virtual machine.

Each new NFT output carries 1,000 sats. The normal fee contribution is 1,000 sats
per person; sub-dust change can raise it to 1,545 sats. Excess BCH attached to the
original NFT returns as change. Token-bearing UTXOs are never selected as
additional fee inputs. Exact accounting is displayed before approval.

Signing rooms have a ten-minute off-chain window. Offers last 24 hours.
Cancelling or expiring a pending room releases coordinator reservations, but
**cannot cryptographically revoke signed copies**. A fully signed transaction
has no on-chain expiry and cannot be cancelled here. Any participant can export
or broadcast its exact bytes. If a node reply is lost, the coordinator preserves
those bytes and reservations, checks the existing TXID, and retries only the
same transaction.

The coordinator can censor, go offline, or misreport discovery information. It
cannot alter a fully signed trade without invalidating signatures. Listings are
not proof of wallet control. Reservations are not on-chain locks; wallets can
spend their inputs elsewhere. Electrum responses are checked against raw source
transactions, but a public node is not a substitute for an independently trusted
view of the chain. Mempool acceptance is not confirmation, and confirmation
counts can decrease during reorganizations.

**Experimental, unaudited software. Start with low-value assets. Never share a
seed phrase.**

## Verification

```sh
npm run check             # Format, lint, types, unit/integration tests, build, production smoke test
npm run test:regressions  # Reintroduces nine guarded bugs and requires the focused tests to fail
npm run test:e2e          # Builds and runs the real three-browser flow
npm audit
```

If Playwright reports that Chromium is missing, install it with
`npx playwright install chromium` and rerun. Set `PLAYWRIGHT_PORT` to use a
different local test port.

The 47 Vitest tests cover matching, consensus/signature rules, Electrum source
validation, persistence, API authorization, asynchronous races, expiration,
uncertain broadcasts, reorgs, and real encrypted wallet communication. Three
Playwright tests cover mobile layout and Mainnet consent, altered-offer rejection,
and the complete three-browser lifecycle, including corrupted original-offer
protection, cancellation/repreparation, wallet rejection, the third-signature
gate, reload, export, identical-byte retry, actual NFT/change movement, and
confirmation labels.

Browser tests run the production bundle under its Content Security Policy.
Screenshots and failed-run traces are written to ignored `test-results/`.
The same commands can be used in CI; install Chromium with
`npx playwright install --with-deps chromium` on a fresh Linux runner. Automated
tests use ephemeral local assets and do not spend real funds.

## Repository map

| Path              | Responsibility                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| `src/shared/`     | Cycle matching, transaction construction, independent validation, and signature aggregation.                 |
| `src/server/`     | HTTP/session boundaries, SQLite state machine, reservations, and Electrum.                                   |
| `src/web/`        | Marketplace, wallet integration, original-offer checks, review rooms, and pitch.                             |
| `tests/fixtures/` | Ephemeral signing wallets, encrypted relay, and consensus-verifying ledger. Never production key management. |
| `e2e/`            | Loopback-only demo harness and three-browser tests.                                                          |
| `scripts/`        | Deliberate regression mutations and compiled-server smoke verification.                                      |

## BLAZE submission gates, owned by the repository owner

- Choose a source license and make the repository public when ready. It is
  intentionally still private and marked `UNLICENSED`.
- Configure and independently verify the token-aware prize address.
- Complete the wallet-specific funded Chipnet pilot and a small Mainnet
  acceptance test. A working Mainnet submission is not established by the local
  fixture demo.
- Deploy the application on HTTPS after reviewing the operational limits.
- Record the working three-collector demo and link the presentation and public
  repository. Disclose pre-event work where required by the event rules.
- This build integrates WizardConnect, not XO. No XO-specific bounty eligibility
  is claimed.

The presentation is part of the app at `/#pitch`. The hackathon banner links it
and the repository, and shows the configured prize address without inventing one.

Third-party packages retain their licenses. Libauth, CashScript, Express, React,
and Zod use MIT licenses; Lucide uses ISC. The unmodified WizardConnect source
files carry LGPL-3.0-or-later notices, including copyright Whiterun LLC.
[WizardConnect upstream source](https://gitlab.com/riftenlabs/lib/wizardconnect)
and the installed dependency notices must remain available, with applicable LGPL
distribution/relinking requirements satisfied before publishing a build. No
license choice or legal clearance for this application is implied.
