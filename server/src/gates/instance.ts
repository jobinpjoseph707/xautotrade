import { SqliteGateStore } from './sqlite.js';

/** The one gate history for the running server. */
export const gateStore = new SqliteGateStore();
