import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElectrumNetworkProvider } from 'cashscript';
import { ElectrumChain } from '../src/server/chain.js';
import { binToHex, encodeTransactionCommon } from '@bitauth/libauth';
import { decodeTransaction } from '../src/shared/bitcoin.js';
import { testActors } from './fixtures/actors.js';
import { FixtureChain } from './fixtures/chain.js';

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const actors = testActors();
  const ledger = new FixtureChain();
  ledger.addActors(actors);
  vi.spyOn(ElectrumNetworkProvider.prototype, 'connect').mockResolvedValue();
  vi.spyOn(ElectrumNetworkProvider.prototype, 'disconnect').mockResolvedValue(
    true,
  );
  vi.spyOn(ElectrumNetworkProvider.prototype, 'getUtxos').mockImplementation(
    async (address) =>
      [...ledger.utxos.values()]
        .filter((utxo) => utxo.address === address)
        .map((utxo) => ({
          txid: utxo.txid,
          vout: utxo.vout,
          satoshis: BigInt(utxo.satoshis),
          lockingBytecode: utxo.lockingBytecode,
          ...(utxo.token && {
            token: { ...utxo.token, amount: BigInt(utxo.token.amount) },
          }),
        })),
  );
  const getRaw = vi
    .spyOn(ElectrumNetworkProvider.prototype, 'getRawTransaction')
    .mockImplementation(async (txid) => ledger.rawTransactions.get(txid)!);
  return { actors, ledger, getRaw, chain: new ElectrumChain() };
}

describe('actual Electrum adapter verification', () => {
  it('checks a real raw source transaction before trusting its NFT and fee metadata', async () => {
    const f = fixture();
    await f.chain.verifyUtxos('chipnet', [
      f.actors[0].nft,
      ...f.actors[0].funding,
    ]);
    expect(f.getRaw).toHaveBeenCalledTimes(1);
  });

  it('rejects a node returning a different raw transaction under the requested ID', async () => {
    const f = fixture();
    const changed = decodeTransaction(
      f.ledger.rawTransactions.get(f.actors[0].nft.txid)!,
    );
    changed.locktime = 1;
    f.getRaw.mockResolvedValue(binToHex(encodeTransactionCommon(changed)));
    await expect(
      f.chain.verifyUtxos('chipnet', [f.actors[0].nft]),
    ).rejects.toMatchObject({ code: 'NODE_INCONSISTENCY' });
  });

  it('rejects invented UTXO values even if an indexer reports them as unspent', async () => {
    const f = fixture();
    f.ledger.utxos.get(`${f.actors[0].nft.txid}:0`)!.satoshis = '5000000';
    const invented = { ...f.actors[0].nft, satoshis: '5000000' };
    await expect(
      f.chain.verifyUtxos('chipnet', [invented]),
    ).rejects.toMatchObject({ code: 'SOURCE_MISMATCH' });
  });

  it('uses history height for confirmations, not mere transaction availability', async () => {
    const f = fixture();
    const request = vi.spyOn(
      ElectrumNetworkProvider.prototype,
      'performRequest',
    );
    const tip = vi
      .spyOn(ElectrumNetworkProvider.prototype, 'getBlockHeight')
      .mockResolvedValue(101);
    request.mockResolvedValue([{ tx_hash: f.actors[0].nft.txid, height: 0 }]);
    expect(
      await f.chain.observe('chipnet', f.actors[0].nft.txid, [
        f.actors[0].nft.address,
      ]),
    ).toEqual({ found: true, confirmations: 0 });
    expect(tip).not.toHaveBeenCalled();
    request.mockResolvedValue([{ tx_hash: f.actors[0].nft.txid, height: 100 }]);
    expect(
      await f.chain.observe('chipnet', f.actors[0].nft.txid, [
        f.actors[0].nft.address,
      ]),
    ).toEqual({ found: true, confirmations: 2 });
    request.mockResolvedValue([]);
    expect(
      await f.chain.observe('chipnet', f.actors[0].nft.txid, [
        f.actors[0].nft.address,
      ]),
    ).toEqual({ found: false, confirmations: 0 });
  });
});
