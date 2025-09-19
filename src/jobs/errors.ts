export class TransientJobError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = 'TransientJobError';
  }
}

export class PermanentJobError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = 'PermanentJobError';
  }
}
