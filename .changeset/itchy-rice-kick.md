---
"@atmo-dev/contrail": minor
---

A third community-creation mode: **provision**. alongside the existing `adopt` (caller already has a `did:plc`) and `mint` (caller wants a DID but brings their own PDS) modes, contrail can now provision a community on a stock `@atproto/pds` end-to-end — minting the `did:plc`, creating and activating the PDS account, generating an app password, and persisting credentials so the existing `community.putRecord` / `.deleteRecord` publish path keeps working. contrail never holds PDS admin credentials.

**`xrpc/{ns}.community.provision`** runs the five-step PLC + PDS dance (key generation → PLC genesis → `createAccount` → `getRecommendedDidCredentials` + signed PLC update op → `activateAccount`), persists each step in a new `provision_attempts` table so a partially-failed attempt can be resumed, mints an app password, and seeds the session cache.

**`contrail reap [--all-stuck] [--dry-run]`** new CLI subcommand that cleans up provision attempts which didn't reach `status='activated'` by tombstoning their PLC entries. `--dry-run` is the default; per-row confirmation is required for live reaping unless `--all-stuck` is given.

custody model: the caller supplies a `rotationKey` and that key sits at `rotationKeys[0]` — the highest-priority rotation slot on the resulting DID. contrail generates a subordinate keypair and persists it (AES-GCM-encrypted under `masterKey`) at `rotationKeys[1]`, so it can submit later PLC ops on the community's behalf — most importantly the post-activation PLC update during provision, and the tombstone op that `reap` issues to clean up stuck DIDs.

the caller's key dominates: PLC's 72-hour nullification window means any op contrail signs with its subordinate key can be overridden within 72h by an op signed with the caller's key. with this caveat: a tombstone is irrevocable. a malicious or compromised contrail instance could tombstone any DID it provisioned. there is no managed code path, no shared rotation, and `rootCredentials` are returned to the caller in the response so they can also be persisted out-of-band.

what you need to configure / know:

- new `community` config block: `masterKey` (32-byte AES-GCM envelope key for the encrypted credential columns), optional `allowedPdsEndpoints` (URL-origin matching, collapses scheme case / default ports / trailing slash / IDN), optional `plcDirectory` override.

- new tables `provision_attempts` and `community_credentials`. credentials are stored AES-GCM-encrypted under the master key; lose the master key, lose the ability to mint sessions for previously-provisioned communities.
