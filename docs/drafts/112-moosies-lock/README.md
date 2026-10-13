# Migration 112 — local test

Same throwaway cluster as `../111-moosies/README.md` (schema-only Moosii restore + stubs + seed + 111), then:

```
psql … -d m111 -v ON_ERROR_STOP=1 -f ../../../migrations/112_moosies_lock_and_diagnostic_once.sql
psql … -d m111 -v ON_ERROR_STOP=1 -f verify.sql        # rolled back; also run live after each apply
MOOSIE_TEST_DB_URL=postgres://postgres@localhost:55432/m111 npm test
```
