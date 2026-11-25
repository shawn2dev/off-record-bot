export class XpError extends Error {
  constructor(code) {
    super(code);
    this.name = 'XpError';
    this.code = code;
  }
}
