/** Typed messages between the compositor pool and its workers. */

export interface CompositeRequest {
  readonly id: number;
  /** PNG bytes; the ArrayBuffers are transferred, not copied. */
  readonly older: ArrayBuffer;
  readonly newer: ArrayBuffer;
}

export type CompositeResponse =
  | { readonly id: number; readonly ok: true; readonly png: ArrayBuffer }
  | { readonly id: number; readonly ok: false; readonly error: string };
