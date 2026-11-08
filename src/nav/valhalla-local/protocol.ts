/**
 * Message protocol between the app and the offline Valhalla worker.
 *
 * One request/response pair per message, `seq`-correlated. Deliberately small:
 * the worker is a thin host around `runtime.ts`, and anything that needs
 * richer state lives there rather than in the protocol.
 */

import type { Route, RouteRequest } from '../valhalla';

export type WorkerRequest =
  | { type: 'mount'; seq: number; region: string; bytes: ArrayBuffer }
  | { type: 'unmount'; seq: number; region: string }
  | { type: 'route'; seq: number; request: RouteRequest }
  | { type: 'regions'; seq: number }
  | { type: 'dispose'; seq: number };

export type WorkerResponse =
  | { type: 'ok'; seq: number; route?: Route; regions?: string[] }
  | { type: 'error'; seq: number; message: string; detail?: string; status?: number };
