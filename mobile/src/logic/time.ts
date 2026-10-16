/**
 * Every time the app shows is shown in Indian Standard Time (IST, UTC+5:30, no
 * daylight saving), whatever the computer's own clock says. The server and the
 * bots keep working in UTC; only what is displayed changes.
 */
export const IST_ZONE = 'Asia/Kolkata';
export const IST_LABEL = 'IST';

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone: IST_ZONE, hourCycle: 'h23', ...opts });

const TIME = fmt({ hour: '2-digit', minute: '2-digit' });
const TIME_S = fmt({ hour: '2-digit', minute: '2-digit', second: '2-digit' });
const DATE = fmt({ month: 'short', day: 'numeric' });
const DATE_TIME = fmt({ month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const DATE_TIME_S = fmt({ month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const FULL = fmt({ year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** 14:05 */
export const istTime = (ts: number): string => TIME.format(ts);
/** 14:05:09 */
export const istTimeSeconds = (ts: number): string => TIME_S.format(ts);
/** 9 Oct */
export const istDate = (ts: number): string => DATE.format(ts);
/** 9 Oct, 14:05 */
export const istDateTime = (ts: number): string => DATE_TIME.format(ts);
/** 9 Oct, 14:05:09 */
export const istDateTimeSeconds = (ts: number): string => DATE_TIME_S.format(ts);
/** 9 Oct 2026, 14:05 */
export const istFull = (ts: number): string => FULL.format(ts);
