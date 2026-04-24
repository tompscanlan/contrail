---
"@atmo-dev/contrail": patch
---

tighten spaces ACL: owners no longer bypass the "own-record" rule on delete. everyone in the member list — owner included — can only delete records they authored.

before: owner calling `space.deleteRecord` on someone else's record returned `200 { ok: true }` (ACL passed, but the adapter's SQL was already scoped to `did = caller`, so no rows were actually deleted — the response lied).

after: that same call returns `403 { error: "Forbidden", reason: "not-own-record" }`. honest response; no behavior change at the storage layer.

to wipe someone else's records in a space you own, delete the space itself.
