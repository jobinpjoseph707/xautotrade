// Loaded with `--import` before every test file (see package.json "test").
// Keeps tests off the real database file.
process.env.DB_PATH ??= ':memory:';
