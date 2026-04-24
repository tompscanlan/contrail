---
"@atmo-dev/contrail-lexicons": minor
---

add `contrail-lex publish` subcommand. wraps `publishLexicons` so you can push lexicon JSON to a PDS without writing a script:

```bash
contrail-lex publish <handle> <app-password>
# or via env:
LEXICON_ACCOUNT_IDENTIFIER=you.bsky.social LEXICON_ACCOUNT_PASSWORD=xxxx contrail-lex publish
```

supports `--generated-dir` (default `lexicons-generated`), `--skip-confirm` (for CI), and `--dry-run` (print what would be published + the DNS records needed, no writes, credentials not required).
