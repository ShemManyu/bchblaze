export function shortHex(value: string, length = 6): string {
  if (value.length <= length * 2 + 3) return value;
  return `${value.slice(0, length)}...${value.slice(-length)}`;
}

export function formatBch(satoshis: bigint | string): string {
  const amount = BigInt(satoshis);
  const whole = amount / 100_000_000n;
  const fraction = (amount % 100_000_000n)
    .toString()
    .padStart(8, '0')
    .replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''} BCH`;
}

export function explorerUrl(network: string, txid: string): string {
  return network === 'mainnet'
    ? `https://explorer.bitcoinunlimited.info/tx/${txid}`
    : `https://chipnet.imaginary.cash/tx/${txid}`;
}
