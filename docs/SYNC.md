# Sync across machines

`ws sync` keeps your workstream data the same on several machines (a laptop, a workstation, a
server you reach from your phone) by treating the data folder as a git repo. It is off until you
set it up, and it needs nothing but git and an SSH-reachable (or local) git remote you control.

## How it works

- **Each machine commits, fetches, merges and pushes.** `ws sync` runs in the background a few
  seconds after anything is written (a CLI command, an MCP call, a session ending), when a session
  starts, and every 2 minutes if you install the timer. Hooks never wait on the network.
- **Records merge item by item.** `open.md`, `decisions.md` and `WORKSTREAM.md` go through a merge
  driver (`ws merge-driver`) instead of git's line merge:
  - a change on one side wins; closing an item or superseding a decision is never undone;
  - text edited on both sides keeps the other machine's wording and adds yours as an `also:` line;
  - the same new ID added on two machines before they synced: the one pushed first keeps it, the
    other is renumbered to the next free ID, and `ws sync` says so (`renumbered PR-2 -> PR-3`).
- **Everything else is one file per session** (logs, inbox entries, drafts), so machines don't
  collide. Logs and inbox entries record which machine wrote them (`host:`).
- **Safe by default.** A merge runs while holding ws's own locks on the files it changes. A merge
  that fails is aborted, your local commits stay, and nothing is force-pushed; if git can't undo it,
  sync stops and commits nothing until the repo is clean. A sync killed in the middle is undone and
  redone by the next one. A sync that stops says so at the start of your next session, and
  problems from background syncs go to `sync-problems.log` in the data folder.
- **Never synced:** `config.json` (each machine's own), the summary queue (jobs point at local
  transcripts), locks, the trash, and eval transcript copies. This is enforced in code, not only
  by `.gitignore`: outgoing commits drop these paths and links whatever `.gitignore` says.
- **The remote is data, never code or settings.** Before merging, ws checks everything incoming and
  stops the sync (`refused`, shown at the next session start) if the remote has symlinks,
  submodules, a machine's own files (`config.json`, the queue, locks), `.gitattributes` or `.git*`
  files in subfolders, or ignore rules that un-ignore something. Front matter must be plain YAML
  (`---`); anything else (`---js`) is refused when read, never evaluated. git runs with hooks off,
  symlinks checked out as plain files, and your signing and fast-forward-only settings ignored.
- **Two machines changed the same field** of `WORKSTREAM.md` (status, title): the local value is
  kept. A workstream deleted on one machine and edited on another stops that repo's sync until you
  restore or delete it on both.

## Set up

1. **A remote you control.** For example a bare repo on an always-on machine you reach over SSH:

   ```bash
   ssh server 'git init -q --bare ~/ws-hub/main.git'
   ```

   Workstream data can hold client and personal details; prefer your own hardware over a hosted
   service unless you are sure it may live there. Anyone who can push to the remote can change
   what your sessions read (open items go into resume prompts), so keep write access to machines
   you control. For a machine that should reach only one repo, give it its own SSH key with a
   forced command that allows just `git-upload-pack` / `git-receive-pack` on that repo.

2. **On each machine**, add to `config.json` in the data folder (`ws` prints its path):

   ```json
   { "sync": { "machine": "laptop", "remote": "server:ws-hub/main.git" } }
   ```

   Then `ws sync` once. The first machine pushes what it has; the others merge it in. A machine that
   already had its own data merges it with the remote's (unrelated histories are allowed once).

3. **Optional:** `ws sync --install` runs a sync every 2 minutes (launchd on macOS, a systemd user
   timer on Linux), so a machine picks up others' changes even when nothing is written there.
   `ws sync --status` shows what is waiting to go out or come in.

## Shares: some workstreams on some machines

A **share** is a second repo for the workstreams whose ids match its patterns. Their folders live in
`shares/<name>/` and sync only to that share's remote, so a machine can have, say, the clinic
workstreams without anything else:

```json
{ "sync": { "machine": "laptop", "remote": "server:ws-hub/main.git",
            "shares": [{ "name": "clinic", "match": ["clinic-*", "billing"], "remote": "server:ws-hub/clinic.git" }] } }
```

A machine that should only see the share leaves out `remote` and lists the share alone; its other
workstreams (if any) stay local. Routing is by id, so a new `clinic-x` lands in the share on every
machine. Set up shares before the first push: once data is in a repo's history, every clone of it
has it.

To move existing workstreams into a new share on the machine that has them: add the share to
`config.json`, then move each folder from `ws/<id>` to `shares/<name>/ws/<id>` (and
`proposals/<id>` to `shares/<name>/proposals/<id>`), then `ws sync`.

## Folders that differ between machines

Workstreams store folders as written on the machine that set them (`cwd`, `sources`). When a project
lives somewhere else on another machine, map the prefix in that machine's `config.json`:

```json
{ "paths": { "~/Desktop/Projects/site": "~/src/site" } }
```

Sessions in `~/src/site` then match the workstream, sources resolve, and paths this machine writes
are stored in the other form. A source or project folder that doesn't exist on a machine at all is
listed in the resume prompt as "not on this machine" instead of failing it.

## Unattended runs

Scheduled agent runs (a `claude -p` loop on a server) would each be captured as a session. Set
`WS_CAPTURE=0` in their environment to leave them out.
