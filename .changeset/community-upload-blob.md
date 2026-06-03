---
"@atmo-dev/contrail-community": minor
---

Add a `community.uploadBlob` custodian proxy so community-event blob uploads land in the community repo. Mirrors `community.putRecord` (publishers ACL + session + raw-bytes proxy to the community PDS's `com.atproto.repo.uploadBlob`), so blob refs resolve from the same repo that holds the referencing record.
