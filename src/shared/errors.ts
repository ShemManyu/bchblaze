export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly outpoint?: { txid: string; vout: number },
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
