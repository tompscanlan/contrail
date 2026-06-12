---
"@atmo-dev/contrail-appview": patch
---

fix(ingest): stop the ingest cycle hanging on a quiet or all-filtered Jetstream

Race `iterator.next()` against the safety timeout and check the exit conditions before each event, so a low-traffic stream no longer blocks until the caller's hard timeout kills the cycle with the batch and cursor unwritten.
