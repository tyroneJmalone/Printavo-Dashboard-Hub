export class CalcPushError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | "not_found"
      | "invalid"
      | "conflict"
      | "locked"
      | "upload_not_ready",
  ) {
    super(message);
    this.name = "CalcPushError";
  }
}