---
"@atmo-dev/contrail-lexicons": patch
---

fix `contrail-lex --config <path.ts>` with plain TS files. previously broke with `ERR_UNKNOWN_FILE_EXTENSION` under plain node — bare `contrail-lex` invocation couldn't load TS configs. now uses `jiti` to handle TS + ESM + CJS transparently, so invocations like `contrail-lex all --config src/config.ts` work without needing tsx/ts-node preregistered.
