export type Network = 'chipnet' | 'mainnet';
export type PathName = 'receive' | 'change' | 'defi';

export interface AddressPath {
  address: string;
  path: PathName;
  index: number;
}

export interface Outpoint {
  txid: string;
  vout: number;
}

export interface TokenData {
  category: string;
  amount: string;
  nft?: {
    capability: 'none' | 'mutable' | 'minting';
    commitment: string;
  };
}

export interface SerializedOutput {
  valueSatoshis: string;
  lockingBytecode: string;
  token?: TokenData;
}

export interface WalletUtxo extends Outpoint, AddressPath {
  satoshis: string;
  lockingBytecode: string;
  token?: TokenData;
}

export interface NftAsset extends Outpoint {
  category: string;
  commitment: string;
}

export interface WantedAsset {
  category: string;
  commitment: string;
  outpoint?: Outpoint;
}

export type OfferStatus =
  'open' | 'reserved' | 'settled' | 'cancelled' | 'expired' | 'invalid';

export interface Offer {
  id: string;
  network: Network;
  receiveAddress: string;
  label: string;
  asset: NftAsset;
  wanted: WantedAsset;
  createdAt: number;
  expiresAt: number;
  status: OfferStatus;
  circleId?: string;
  isMine?: boolean;
}

export interface CreateOffer {
  network: Network;
  receiveAddress: string;
  addressPaths: AddressPath[];
  offered: Outpoint;
  wanted: WantedAsset;
  label: string;
}

export interface TradeCycle {
  id: string;
  offers: [Offer, Offer, Offer];
}

export interface ProposalParticipant {
  offerId: string;
  receiveAddress: string;
  label: string;
  sendAsset: NftAsset;
  receiveAsset: NftAsset;
  inputIndexes: number[];
  inputPaths: [number, PathName, number][];
  inputSatoshis: string;
  changeSatoshis: string;
  feeSatoshis: string;
}

export interface SwapProposal {
  network: Network;
  unsignedTransaction: string;
  sourceOutputs: SerializedOutput[];
  participants: [ProposalParticipant, ProposalParticipant, ProposalParticipant];
  fingerprint: string;
  feeSatoshis: string;
  maximumSignedSize: number;
}

export type CircleStatus =
  | 'preparing'
  | 'awaiting_signatures'
  | 'ready'
  | 'broadcasting'
  | 'broadcast_unknown'
  | 'broadcast'
  | 'confirmed'
  | 'cancelled'
  | 'expired'
  | 'failed';

export interface CircleParticipant {
  offerId: string;
  receiveAddress: string;
  label: string;
  asset: NftAsset;
  signed: boolean;
  signedAt?: number;
  isMine: boolean;
}

export interface Circle {
  id: string;
  network: Network;
  status: CircleStatus;
  participants: [CircleParticipant, CircleParticipant, CircleParticipant];
  createdAt: number;
  expiresAt: number;
  version: number;
  txid?: string;
  confirmations?: number;
  error?: string;
  proposal?: SwapProposal;
}

export interface MarketSnapshot {
  offers: Offer[];
  cycles: TradeCycle[];
  circles: Circle[];
}

export interface NetworkStatus {
  network: Network;
  available: boolean;
  blockHeight?: number;
  checkedAt: number;
}
