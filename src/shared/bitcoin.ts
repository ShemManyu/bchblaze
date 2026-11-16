import {
  binToHex,
  cashAddressToLockingBytecode,
  decodeTransactionCommon,
  hashTransaction,
  hexToBin,
  lockingBytecodeToCashAddress,
  ripemd160,
  sha256,
  type Output,
  type TransactionCommon,
} from '@bitauth/libauth';
import { DomainError } from './errors.js';
import type {
  Network,
  NftAsset,
  SerializedOutput,
  WalletUtxo,
} from './types.js';

export function assertCondition(
  condition: unknown,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new DomainError(code, message);
}

export function bytes(value: string): Uint8Array {
  assertCondition(
    /^(?:[0-9a-f]{2})*$/i.test(value),
    'INVALID_HEX',
    'Expected a hexadecimal byte string.',
  );
  return hexToBin(value);
}

export function addressBytecode(address: string, network: Network): Uint8Array {
  const result = cashAddressToLockingBytecode(address);
  assertCondition(
    typeof result !== 'string',
    'INVALID_ADDRESS',
    'Use a valid CashAddress.',
  );
  assertCondition(
    result.prefix === (network === 'mainnet' ? 'bitcoincash' : 'bchtest'),
    'WRONG_NETWORK',
    `Use a ${network} address.`,
  );
  assertCondition(
    isP2pkh(result.bytecode),
    'UNSUPPORTED_ADDRESS',
    'SwapCircle currently supports P2PKH wallets.',
  );
  return result.bytecode;
}

export function isP2pkh(bytecode: Uint8Array): boolean {
  return (
    bytecode.length === 25 &&
    bytecode[0] === 0x76 &&
    bytecode[1] === 0xa9 &&
    bytecode[2] === 0x14 &&
    bytecode[23] === 0x88 &&
    bytecode[24] === 0xac
  );
}

export function publicKeyBytecode(publicKey: Uint8Array): Uint8Array {
  assertCondition(
    publicKey.length === 33 && (publicKey[0] === 2 || publicKey[0] === 3),
    'INVALID_PUBLIC_KEY',
    'Expected a compressed wallet public key.',
  );
  const hash = ripemd160.hash(sha256.hash(publicKey));
  return Uint8Array.from([0x76, 0xa9, 0x14, ...hash, 0x88, 0xac]);
}

export function tokenAddress(bytecode: Uint8Array, network: Network): string {
  const result = lockingBytecodeToCashAddress({
    bytecode,
    prefix: network === 'mainnet' ? 'bitcoincash' : 'bchtest',
    tokenSupport: true,
  });
  assertCondition(
    typeof result !== 'string',
    'INVALID_ADDRESS',
    'Could not derive a token-aware address.',
  );
  return result.address;
}

export function serializeOutput(output: Output): SerializedOutput {
  return {
    valueSatoshis: output.valueSatoshis.toString(),
    lockingBytecode: binToHex(output.lockingBytecode),
    ...(output.token && {
      token: {
        category: binToHex(output.token.category),
        amount: output.token.amount.toString(),
        ...(output.token.nft && {
          nft: {
            capability: output.token.nft.capability,
            commitment: binToHex(output.token.nft.commitment),
          },
        }),
      },
    }),
  };
}

export function deserializeOutput(output: SerializedOutput): Output {
  return {
    valueSatoshis: BigInt(output.valueSatoshis),
    lockingBytecode: bytes(output.lockingBytecode),
    ...(output.token && {
      token: {
        category: bytes(output.token.category),
        amount: BigInt(output.token.amount),
        ...(output.token.nft && {
          nft: {
            capability: output.token.nft.capability,
            commitment: bytes(output.token.nft.commitment),
          },
        }),
      },
    }),
  };
}

export function utxoOutput(utxo: WalletUtxo): Output {
  return deserializeOutput({
    valueSatoshis: utxo.satoshis,
    lockingBytecode: utxo.lockingBytecode,
    token: utxo.token,
  });
}

export function nftAsset(utxo: WalletUtxo): NftAsset {
  assertCondition(
    utxo.token?.nft?.capability === 'none' &&
      utxo.token.amount === '0' &&
      utxo.token.nft.commitment.length <= 80,
    'UNSUPPORTED_ASSET',
    'Trade an immutable NFT with no attached fungible token balance.',
  );
  return {
    txid: utxo.txid,
    vout: utxo.vout,
    category: utxo.token.category,
    commitment: utxo.token.nft.commitment,
  };
}

export function decodeTransaction(
  hex: string,
  maximumBytes = 10_000,
): TransactionCommon {
  assertCondition(
    hex.length > 0 && hex.length <= maximumBytes * 2,
    'INVALID_TRANSACTION',
    'The transaction is empty or exceeds the supported size.',
  );
  const transaction = decodeTransactionCommon(bytes(hex));
  assertCondition(
    typeof transaction !== 'string',
    'INVALID_TRANSACTION',
    'The transaction could not be decoded.',
  );
  return transaction;
}

export function transactionId(hex: string): string {
  return hashTransaction(bytes(hex));
}

export function sameOutput(a: Output, b: Output): boolean {
  return (
    JSON.stringify(serializeOutput(a)) === JSON.stringify(serializeOutput(b))
  );
}
