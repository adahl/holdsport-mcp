# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Runtime is **Bun** (not Node) — both binaries have `#!/usr/bin/env bun` shebangs, and `tsconfig.json` uses `allowImportingTsExtensions`/`noEmit` (imports carry `.ts` extensions; Bun runs the TypeScript directly).

```sh
bun install
bun test                        # all tests — offline, global fetch is mocked
bun test test/client.test.ts    # one file
bun test -t "pattern"           # tests matching a name pattern
bunx tsc --noEmit               # type check (no build step exists)

bun bin/holdsport help          # run the CLI (credentials from .env, auto-loaded by Bun)
bun bin/holdsport-mcp           # run the MCP server (stdio)
```

CLI credentials come from `.env`: `HOLDSPORT_USERNAME`, `HOLDSPORT_PASSWORD`, `HOLDSPORT_TEAM_ID`. The username must be the **login username** (not email or member number) — GraphQL `SignIn` accepts only that form.

## Architecture

Two front-ends over one shared data layer:

- `src/client.ts` — `HoldsportClient`: all API access and business logic, shared by both binaries. Returns plain JS data and throws `Error`; it never prints or calls `process.exit` — each front-end decides presentation (CLI prints and exits; MCP maps throws to tool errors).
- `src/render.ts` — CLI-only terminal rendering (tables, CSV, transcripts). The MCP server never imports it; it returns pretty-printed JSON.
- `bin/holdsport` — CLI: arg parsing + dispatch to client + render.
- `bin/holdsport-mcp` — MCP server: pure tool wiring around the client. Credentials arrive **per tool call** (`username`/`password`/`team_id` arguments); a fresh client is built per call and the server itself holds no credentials or startup args.

### Two backends inside the client

- **REST** (`https://api.holdsport.dk/v1`, HTTP Basic auth): teams, members, roster, notes, tasks. Documented at https://github.com/Holdsport/holdsport-api.
- **GraphQL** (`https://www.holdsport.dk/graphql`): chat, email, activities, event types — reverse-engineered from the mobile app, not documented anywhere. It silently returns `{}` without an `X-App-Version` header; auth is a `SignIn` mutation that mints a token, cached in-process per login (`accessTokenCache` / `clearChatTokenCache`). Query/mutation strings live as constants in `client.ts`.

### Read-only by design — preserve this

Everything is a read except `createActivity` / `updateActivity` / `respondToActivity`. Deliberate safety properties that must not be eroded:

- No raw request/path/GraphQL escape hatch in the CLI or MCP tools. The one endpoint not fixed in advance is `respondToActivity`'s, which comes from the activity's own `actions` — bounded instead by refusing a missing path or method, and refusing any host but `api.holdsport.dk`.
- **A new client capability needs an MCP tool.** The MCP server is the point of the package; leaving a method CLI-only quietly halves the feature.
- Writes are gated: CLI `--yes` (dry-run/diff by default), MCP `confirm: true`.
- `send()` is the client's **only** REST write transport and exists solely for `respondToActivity`. It is private, and callers never assemble a path — the path comes from the activity itself. It is also never *defaulted*: a missing `action_path` or `action_method` is refused, because defaulting them rebuilds the two things reading them from the server was meant to avoid.
- No delete is exposed anywhere. The API *can* delete — `CancelActivity` with `mark_as_canceled: false` removes an activity outright (verified live) — but no command or tool wraps it, deliberately.

### Write-path invariants (verified against production — don't "simplify" them away)

- The create/update mutations take **no team argument**; they hit the login's *current team*. The client therefore runs `ChangeCurrentTeam` first and refuses to write unless the server confirms the switch landed on the intended team — for create that's the configured/`--team` team, for update the activity's *own* team, read from the activity itself. Visible side effect: the login's current team in the Holdsport app switches too.
- `updateActivity` is **read-modify-write with a full echo**: the server NULLs every input field omitted from `UpdateActivityInput`, so the client fetches current state, merges changes, and sends everything back. A partial send silently wipes settings (verified: an update omitting `activity_type` dies on that column's NOT NULL constraint). Payment activities are refused because their fields can't be read back.
- The CLI/MCP `registration_type` names map to the mutations' `activity_type` int; the name↔code mapping is documented in the GraphQL schema's own description of `Activity.type`. On update, a code this client doesn't know (a future server value) is echoed verbatim, never guessed.
- Times on the wire are full `YYYY-MM-DD HH:MM` datetimes in `start_time`/`end_time` (the separate date fields are ignored by the server; a bare `HH:MM` lands on today). All wall-clock conversion uses `Europe/Copenhagen` (`TEAM_TZ` in client.ts).
- Edits to repeating-series activities always send `update_current_and_future: false` — single occurrence only, hardcoded in both front-ends (`updateActivity` accepts a `repeatScope` option, but no front-end exposes `"future"`); one-off activities never carry the flag.
- Activity `meeting_time` (Mødetid) maps to the API's `pickup_time` field.
- The **sign-up deadline lives only in GraphQL** (`absolute_registration_deadline`), surfaced as `registration_deadline`. REST reports a closed activity solely as an empty `actions` array, so without the GraphQL field a closure can be detected but never explained — and "Tilmeldingsfristen er overskredet" is precisely what the app shows the user. Note it is often null even when a deadline exists in prose: one cup carries "Deadline for tilmelding er 30. august" in its *title* and no structured field at all.
- `activitiesInRange` **throws** when it exhausts `maxPages` without reaching the end of the window. A truncated list is indistinguishable from a complete one, and a caller would report "nothing scheduled" for a range it never reached. Verified live: the server returns empty pages past the end rather than clamping, so this fires only on genuine truncation — and `current_page` merely echoes the page you asked for, so it is no use as a stop signal.
- Activity capacity is `max_attender`, and **Holdsport writes "no limit" as the sentinel 999**, not as an absent value. `ActivitySummary.max_attendees` normalises 999/0/absent to `null`, because otherwise every ordinary session reads "50 of 999".

### Answering an activity (`respondToActivity`)

Signing up or withdrawing is the one REST write. It never constructs the request:

- **The path, HTTP method and body all come from the activity's own `actions`.** They genuinely vary, and the full cycle is verified live (Tilmeld then Afmeld on one activity):

  | state | offered | request |
  | --- | --- | --- |
  | no row yet | Tilmeld *and* Afmeld | `POST /v1/activities/:id/activities_users` |
  | Tilmeldt | Afmeld only | `PUT  /v1/activities/:id/activities_users/:rowId` |
  | Afmeldt | Tilmeld only | `PUT  /v1/activities/:id/activities_users/:rowId` |

  Two consequences. Once a row exists the API offers **only the opposite
  action**, so a caller must read what is on offer rather than assume both.
  And a hardcoded `POST` for the second answer would create a *second*
  attendance row rather than update the first — that is the concrete failure
  this design prevents, observed rather than inferred.
- The same reasoning forbids *defaulting* the pieces: a missing `action_path` or `action_method` is refused, since supplying either rebuilds what reading them from the server was meant to avoid. `send()` also refuses any host but `api.holdsport.dk`, because that path is response data and the request carries HTTP Basic credentials.
- **The actions are re-read immediately before writing.** A plan made an hour earlier may offer a choice the server no longer accepts; the fresh read turns that into a loud failure rather than a forced write.
- An empty `actions` array means registration is closed. Refuse; never fall back to a constructed POST.
- `joined_status` 1 = attending, 2 = not attending — the same semantics as the `status_code` on an attendance row.

## Tests

`bun:test`, fully offline: `stubFetch` in `test/client.test.ts` replaces `globalThis.fetch` with canned responses, and env vars are saved/restored around tests so the real `.env` doesn't leak in. New client behavior should follow this pattern — no live network in tests.
