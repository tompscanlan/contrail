# flo-bit/contrail#95 — reproduction scripts

The evidence behind the #95 review recorded on bead `om-m2u6x` (closed 2026-08-27). Kept so a
future reader can **re-run the findings instead of trusting the prose**.

This branch is #95 head `8de9ba0` ("integrate feedback") plus the scripts in this directory and two
vitest repros under `packages/contrail-spaces-alpha/tests/`. Nothing here modifies upstream code.

## Findings

| Finding | Status | Evidence |
| --- | --- | --- |
| F3 — unbounded oplog pagination | **DEMONSTRATED** | `finding3-pagination.mjs` (live PDS) + `tests/deadline-body-abort.test.ts` (deterministic) |
| F4 — `appAccess` guard fails open | THEORETICAL — the fail-open is real, but `createSpace` refuses the only input that reaches it (400, missing required key) | `finding4-appaccess.mjs` |
| F5 — credential `cnf.jkt` unchecked | THEORETICAL — the client trusts a mis-bound credential, but the server holds the boundary (401 `DpopKeyMismatch`) | `finding5-cnf-jkt.mjs` |

The classification write-ups are the commit messages of `880ef32`, `b3bcc4b` and `1924bff` on branch
`spike/spaces-e2e` (all 2026-08-26). This branch carries the scripts; that one carries the prose.

## Why `finding3-pagination.mjs` here differs from the copy on `spike/spaces-e2e`

That copy is the **pre-feedback** run; this one is the **post-feedback** run against `8de9ba0`, and
the difference is the point:

- pre-feedback: a 2000 ms deadline returned at 4210 ms — `incrementalRepo` took no deadline while
  the writer-listing loop did, so nothing bounded the pagination.
- at `8de9ba0`: the deadline *does* bound the loop, but it can fire **between the response headers
  and the body read**. `listRepoOps` then resolves `undefined` instead of rejecting, the
  `if (signal?.aborted) throw new SyncDeadlineExceededError()` guard never runs, and the engine
  surfaces `TypeError: Cannot read properties of undefined (reading 'ops')` — which is not in
  `syncRepo`'s rethrow list, so an out-of-time deadline is answered with a **full CAR download**.

So the F3 fix traded an unbounded loop for a mis-reported one. That is the open item, and it is why
the #95 follow-up comment is held until the path is hit running a syncer for real (bead `om-5cxui`).

## The two deterministic repros

- `tests/deadline-body-abort.test.ts` — pins the mechanism above with no PDS: a body stream that
  errors mid-read, and the resulting recovery call.
- `tests/minimal-repro.test.ts` — the one-assertion core: `listRepoOps` resolves `undefined` when an
  OK response body cannot be read.

Both are green on this tree (package suite 10 files / 29 tests, measured 2026-09-15). They do **not**
port to `spike/spaces-e2e`: 2 of 6 cases fail there because that branch's `src/` has diverged from
`8de9ba0`. Run them where they were written.

## The other scripts

| Script | What it exercises |
| --- | --- |
| `perimeter.mjs` | the whole space perimeter — auth, membership, policy, read/write surface |
| `sync-engine.mjs`, `sync-engine-delete-variant.mjs` | `SpacesSyncEngine` against a live space, including the delete path |
| `read-path.mjs`, `write-path.mjs` | own-repo reads and authority writes inside a space |
| `app-access.mjs`, `gated-space.mjs`, `gate/server.mjs` | `appAccess` enforcement, with a local server standing in for the allowed client |

## Credentials

Each live script reads a file of `SPIKE_<NAME>_PASSWORD='…'` lines whose path is set at the top of
the script. **That file is not in this repository and must never be committed** — no credential
value appears in any file here. `SPIKE_SERVE_ONLY=1` boots `perimeter.mjs`'s HTTP server only, for a
pre-tunnel smoke test.

Live scripts target `pds.opnmt.net` (the spaces-alpha test PDS). They read; the ones that write say
so in their header.
