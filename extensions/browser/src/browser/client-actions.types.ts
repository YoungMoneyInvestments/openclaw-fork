/**
 * Browser action request types.
 *
 * Defines the closed action union accepted by browser-control `/act` routes and
 * reused by the Browser agent tool.
 */
/** Form field descriptor used by fill actions. */
export type BrowserFormField = {
  ref: string;
  type: string;
  value?: string | number | boolean;
};

/** Normalized browser action request sent to the control server. */
export type BrowserActRequest =
  | {
      kind: "click";
      ref?: string;
      selector?: string;
      targetId?: string;
      doubleClick?: boolean;
      button?: string;
      modifiers?: string[];
      delayMs?: number;
      timeoutMs?: number;
    }
  | {
      kind: "clickCoords";
      x: number;
      y: number;
      targetId?: string;
      doubleClick?: boolean;
      button?: string;
      delayMs?: number;
      timeoutMs?: number;
    }
  | {
      kind: "type";
      ref?: string;
      selector?: string;
      text: string;
      targetId?: string;
      submit?: boolean;
      slowly?: boolean;
      timeoutMs?: number;
    }
  | { kind: "press"; key: string; targetId?: string; delayMs?: number }
  | { kind: "insertText"; text: string; targetId?: string }
  | {
      kind: "hover";
      ref?: string;
      selector?: string;
      targetId?: string;
      timeoutMs?: number;
    }
  | {
      kind: "scrollIntoView";
      ref?: string;
      selector?: string;
      targetId?: string;
      timeoutMs?: number;
    }
  | {
      kind: "drag";
      startRef?: string;
      startSelector?: string;
      endRef?: string;
      endSelector?: string;
      targetId?: string;
      timeoutMs?: number;
    }
  | {
      kind: "select";
      ref?: string;
      selector?: string;
      values: string[];
      targetId?: string;
      timeoutMs?: number;
    }
  | {
      kind: "fill";
      fields: BrowserFormField[];
      targetId?: string;
      timeoutMs?: number;
    }
  | { kind: "resize"; width: number; height: number; targetId?: string }
  | {
      kind: "wait";
      timeMs?: number;
      text?: string;
      textGone?: string;
      selector?: string;
      url?: string;
      loadState?: "load" | "domcontentloaded" | "networkidle";
      fn?: string;
      targetId?: string;
      timeoutMs?: number;
    }
  | { kind: "evaluate"; fn: string; ref?: string; targetId?: string; timeoutMs?: number }
  | { kind: "close"; targetId?: string }
  | {
      kind: "batch";
      actions: BrowserActRequest[];
      targetId?: string;
      stopOnError?: boolean;
    };

/** Distributes `Request` over the act union while making its discriminator optional. */
type WithOptionalActKind<Request> = Request extends BrowserActRequest
  ? Omit<Request, "kind"> & { kind?: BrowserActRequest["kind"] }
  : never;

/**
 * Act request as the agent tool assembles it before dispatch normalization.
 *
 * A nested `request` may arrive partial because flattened top-level act fields
 * repair it (`readActRequestParam`), so the kind can still be missing when no
 * route supplied one. Dispatch narrows this to `BrowserActRequest` once it has
 * confirmed a kind, which keeps the normalized route/HTTP contract unchanged.
 */
export type BrowserActRequestDraft = WithOptionalActKind<BrowserActRequest>;
