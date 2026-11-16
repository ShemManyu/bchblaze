# SwapCircle

Three collectors, one atomic CashTokens trade on Bitcoin Cash.

SwapCircle matches three-party barter cycles and coordinates external wallet
approvals. Spending keys stay in the connected wallets.

## Development

Requires Node.js 22.18 or newer.

```sh
npm ci
cp .env.example .env
npm run dev
```

Open `http://127.0.0.1:5173`.

```sh
npm run check
npm run test:e2e
```

Chipnet is the default. Mainnet must be explicitly selected. Never enter a wallet
seed phrase into SwapCircle.

The repository remains private during development. The owner must select a source
license and publish the repository before submitting it as an open-source BLAZE
entry. Third-party dependencies retain their respective licenses.
