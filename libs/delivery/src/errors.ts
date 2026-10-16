/**
 * A target's server answered a request with an HTTP error status. Carries the
 * status so a caller can tell a refusal of *this event* from trouble with the
 * target as a whole — the two want opposite handling, and the message alone
 * ("google calendar insert failed: 400") isn't something to parse.
 */
export class DeliveryHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }

  /**
   * The server read the request and refused its *content*: a 4xx that isn't
   * about credentials or permission (401/403 — fixed by reconnecting or
   * re-sharing, then everything works again), a resource that isn't there or
   * has moved on (404/409/410), or timing and load (408/423/425/429). Sending
   * the identical payload again will be refused again, so a caller may stop
   * until the payload changes. Everything else — 5xx, network failure, auth —
   * is the target's state, not the event's, and heals without the event
   * changing, so it must keep being retried.
   */
  get rejectedPayload(): boolean {
    const s = this.status;
    if (s < 400 || s >= 500) return false;
    return ![401, 403, 404, 408, 409, 410, 423, 425, 429].includes(s);
  }
}
