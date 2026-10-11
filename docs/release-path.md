# Release path

How merged code reaches the running ConnectWise connector on the owner's machine.
Recorded 11/10/2026 for WS1 item 4 of the ConnectWise MCP tool batch runbook. Ruling D6.

## Purpose and scope

This document records how the installed connector runs, and gives the procedure to
release a merged change to it. It covers one machine: the owner's Windows workstation
with Claude Desktop. It does not cover the Cloudflare Worker or the HTTP gateway mode.

## How the connector runs

| Item | Value |
|---|---|
| Transport | stdio. `MCP_TRANSPORT` defaults to `stdio`, and the process has no listening port |
| Launcher | Claude Desktop (`claude.exe`) starts `node.exe` with the path to `dist\index.js` |
| Config entry | Hand-edited entry in the Claude Desktop config. It is not an installed `.mcpb` extension |
| Build | A local `tsc` build. It is not a published package |
| Process count | Two copies were running on 11/10/2026, both started 10/10/2026 |

How this was found: a live process check of the script path and the listening ports. No
one read the config file for this record.

Because the transport is stdio, upstream issues #101 (SSRF through `X-CW-Url`) and #102
(Host header crash) cannot be reached on this install. They apply only to the HTTP
server and gateway mode. The fixes are still made, because the code ships to others.

## Terms

| Term | Meaning |
|---|---|
| Dev repo | `C:\Dev\GitHub\connectwise-manage-mcp`. All branch work and test builds happen here |
| Release worktree | `C:\Dev\GitHub\connectwise-manage-mcp-release`. A git worktree of the dev repo, detached at `origin/main` |
| Release build | The `dist` folder inside the release worktree |
| Connector entry | The ConnectWise entry in the Claude Desktop config |

## The problem this solves

Before Procedure A, the connector entry pointed at the dev repo's own `dist\index.js`. Any
build in the dev repo, including a build of an unmerged branch, became live at the next
restart of Claude Desktop. A test gate on a feature branch was enough to do it.

The release worktree separates the two. A build in the dev repo no longer changes what
the connector runs.

## Rules

- Build the release worktree only after a merge to `main` on `origin`.
- Keep the release worktree detached at `origin/main`. Never check out the `main` branch
  in it. Git allows a branch in one worktree only, and `main` must stay free in the dev
  repo.
- Never edit, commit or branch in the release worktree.
- Always install with `npm ci --include=dev`. See "Why --include=dev" below.
- Never set `NODE_TLS_REJECT_UNAUTHORIZED`.
- Never paste a key into a shell, a log or a chat.

## Why --include=dev

The shell on this machine can carry `NODE_ENV=production`. With that set, a plain
`npm ci` skips devDependencies. TypeScript is a devDependency, so `npm run build` then
fails because `tsc` is missing. `--include=dev` makes the install the same whatever
`NODE_ENV` holds.

## Procedure A: create the release worktree (once)

**Preconditions**

- The dev repo exists and `origin` is `futurelogic-au/connectwise-manage-mcp`.
- The folder `C:\Dev\GitHub\connectwise-manage-mcp-release` does not exist.
- Node.js and npm are on the path.

**Steps**

Run each command in PowerShell.

1. Fetch the latest `main`.

   ```powershell
   git -C C:\Dev\GitHub\connectwise-manage-mcp fetch origin
   ```

2. Create the release worktree, detached at `origin/main`.

   ```powershell
   git -C C:\Dev\GitHub\connectwise-manage-mcp worktree add --detach C:\Dev\GitHub\connectwise-manage-mcp-release origin/main
   ```

3. Install the dependencies.

   ```powershell
   npm --prefix C:\Dev\GitHub\connectwise-manage-mcp-release ci --include=dev
   ```

4. Build.

   ```powershell
   npm --prefix C:\Dev\GitHub\connectwise-manage-mcp-release run build
   ```

5. Confirm the commit of the release build.

   ```powershell
   git -C C:\Dev\GitHub\connectwise-manage-mcp-release log -1 --format="%h %s"
   ```

6. Owner: change the `args` of the connector entry to
   `C:\Dev\GitHub\connectwise-manage-mcp-release\dist\index.js`. Change nothing else.
7. Owner: quit Claude Desktop fully, then start it again.
8. Run `cw_test_connection` from a Claude Desktop session.

**Acceptance**

- Step 5 shows the head commit of `origin/main`.
- `C:\Dev\GitHub\connectwise-manage-mcp-release\dist\index.js` exists.
- `cw_test_connection` passes.
- The running `node.exe` processes show the release path, not the dev repo path.

## Procedure B: release a merged change

**Preconditions**

- The pull request is merged to `main` on `origin`.
- Procedure A is complete.

**Steps**

1. Fetch the latest `main`.

   ```powershell
   git -C C:\Dev\GitHub\connectwise-manage-mcp-release fetch origin
   ```

2. Record the current commit. You need it for a rollback.

   ```powershell
   git -C C:\Dev\GitHub\connectwise-manage-mcp-release rev-parse --short HEAD
   ```

3. Move the release worktree to the new `origin/main`.

   ```powershell
   git -C C:\Dev\GitHub\connectwise-manage-mcp-release checkout --detach origin/main
   ```

4. Install the dependencies.

   ```powershell
   npm --prefix C:\Dev\GitHub\connectwise-manage-mcp-release ci --include=dev
   ```

5. Build.

   ```powershell
   npm --prefix C:\Dev\GitHub\connectwise-manage-mcp-release run build
   ```

   Verification: the command ends with no error, and the time stamp of `dist\index.js`
   is new. A failed build can leave the old `dist` in place.

6. Owner: quit Claude Desktop fully, then start it again. The connector loads new tools
   only at start.
7. Run `cw_test_connection`, then read one known CW ticket.

**Acceptance**

- The release worktree is at the head commit of `origin/main`.
- `cw_test_connection` passes and the CW ticket read returns.
- A tool added by the merge shows in the tool list.

## Recovery

| If | Then |
|---|---|
| `npm run build` fails with `tsc` not found | Run the install again with `--include=dev`, then build again |
| The build fails for another reason | Do not restart Claude Desktop. The connector keeps the build it loaded at start. Report the error |
| `cw_test_connection` fails after a release | Roll back: run `git -C C:\Dev\GitHub\connectwise-manage-mcp-release checkout --detach <commit from step 2>`, then steps 4 to 7 of Procedure B |
| The connector returns a 403 | Stop and report it. Do not use another person's keys |
| `git worktree add` says the folder exists | Stop. Do not delete the folder. Check what it holds first |
