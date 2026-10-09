import { Inbox } from './inbox.js';
import { SqliteInboxStore } from './sqlite.js';

/** The one inbox for the running server. Handlers (what the buttons do) are set when the app starts. */
export const inbox = new Inbox(new SqliteInboxStore());
