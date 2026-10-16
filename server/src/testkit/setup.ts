// Loaded with `--import` before every test file (see package.json "test").
// Keeps tests off the real database file.
process.env.DB_PATH ??= ':memory:';
// Chart-level files must never land in a real MetaTrader folder from a test.
process.env.MT5_COMMON_FILES ??= `${process.env.TMPDIR ?? '/tmp'}/xat-test-common-files`;
