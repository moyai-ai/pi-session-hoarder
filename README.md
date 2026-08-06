<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/moyai-ai/pi-session-hoarder/main/assets/moyai-logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/moyai-ai/pi-session-hoarder/main/assets/moyai-logo.svg">
    <img src="https://raw.githubusercontent.com/moyai-ai/pi-session-hoarder/main/assets/moyai-logo.svg" alt="Moyai logo" width="240">
  </picture>
</p>

<h1 align="center">🐿️ Pi Session Hoarder</h1>

<p align="center"><strong>Verified local archives for your Pi sessions.</strong></p>

Pi Session Hoarder is a zero-configuration [Pi](https://github.com/earendil-works/pi-mono) extension that continuously archives your active sessions into verified, content-addressed local storage.

It gives developers a durable local history of their Pi work without changing how Pi writes or manages sessions:

- **Automatic checkpoints** — sessions are archived in the background as they evolve.
- **Crash recovery** — missed work is detected and checkpointed when the session starts again.
- **Complete Bash output capture** — supported full-output sidecar files are preserved alongside the session that produced them.
- **Verified storage** — every object is identified by the SHA-256 hash of its original bytes.
- **Efficient storage** — identical content is stored once and compressed with gzip.
- **Safe by design** — Hoarder never replaces, truncates, or deletes Pi's source session files.

Pi's normal JSONL session remains the active write-ahead journal. Hoarder creates an additional local archive; it does not take over Pi persistence.

## 1. Install

Install the npm release with Pi:

```bash
pi install npm:@moyai/pi-session-hoarder
```

To install the latest source directly from GitHub instead:

```bash
pi install https://github.com/moyai-ai/pi-session-hoarder
```

Restart Pi after installation, or run `/reload` in your current Pi session to activate Hoarder immediately. Hoarder begins working automatically when a persisted session starts—there is no required configuration or background service.

> Pi extensions run with your system permissions. Review third-party extension source before installing it.

## 2. Using Session Hoarder

Most of the time, no interaction is necessary. A compact footer indicator shows the current state:

| Indicator | Meaning |
| --- | --- |
| `◇hoard` | The archive is current |
| `↑1 hoard` | A checkpoint is pending |
| `⠋hoard` | A checkpoint is running (animated spinner) |
| `!hoard` | Initialization or the last checkpoint failed |
| `○hoard off` | Hoarder is disabled or the session is not persisted |

The following commands are available during the R1 rollout:

```text
/hoarder status
/hoarder sync
/hoarder git enable
/hoarder storage local
/hoarder storage s3
/hoarder prune
```

- `/hoarder status` reports the active session, selected target, catalog revisions, archive sizes, captured artifact count, and last error when applicable.
- `/hoarder sync` requests an immediate checkpoint instead of waiting for the normal debounce interval.
- `/hoarder git enable` enables PR-safe catalog publication for a trusted Git worktree. Hoarder writes the projection but never stages or commits it.
- `/hoarder storage local` selects local durability without making S3 requests or downloading history.
- `/hoarder storage s3` selects an already configured S3 target and publishes new local checkpoints to it.
- `/hoarder prune` previews and removes only local CAS objects backed by durable verified receipts for the selected S3 target. It never deletes source sessions, catalogs, receipts, configuration, or remote objects.

## 3. What is archived

For each persisted Pi session, Hoarder captures:

1. The active Pi JSONL session file at a stable boundary.
2. Full Bash output files explicitly referenced by Pi at `message.details.fullOutputPath`.

Sidecar discovery is intentionally allowlisted. Hoarder does not follow arbitrary paths from model messages or tool output, recursively scan directories, or archive project files.

Missing Bash sidecars are recorded as warnings and do not prevent the session itself from being archived.

## 4. Storage

### 4.1 Local storage

Local storage is the zero-configuration default and remains the mandatory checkpoint write path. The archive is stored at:

```text
~/.pi/agent/session-hoarder/
  objects/sha256/<hash>.gz
  catalog/<repo-id>/<session-id>.json
  tmp/
```

Session and sidecar bytes are streamed through SHA-256 and gzip. The SHA-256 identity is calculated from the original, uncompressed content; gzip is only the storage encoding. Catalog revisions are published atomically only after every referenced object exists.

Repository identities keep sessions from different projects separate. Git repositories use their normalized `origin` URL when available, then their repository root; directories outside Git use their canonical working path.

The archive uses ordinary JSON catalogs and gzip files rather than a proprietary format. There is not yet a built-in restore command, but each catalog identifies its session object by `sessionObject.digest`. Local object paths are derived from that digest:

```text
objects/sha256/<digest>.gz
```

You can decode an object with standard gzip tooling:

```bash
gzip -dc ~/.pi/agent/session-hoarder/objects/sha256/<digest>.gz > recovered-session.jsonl
```

Catalog schema version 2 stores portable logical object references without machine-specific paths. Existing schema-version-1 catalogs remain readable and are upgraded on the next successful checkpoint commit.

### 4.2 S3 storage

S3-compatible durability is selected with:

```text
/hoarder storage s3
```

The local CAS remains the checkpoint and staging path. Verified gzip objects are replicated to the configured S3 target in the background. Switching back with `/hoarder storage local` synchronously cancels queued or active replication before persisting the local selection. It starts no additional S3 requests, downloads no remote-only history, deletes no remote objects, and does not rewrite committed project catalogs. Existing verified S3 receipts remain available for later explicit retrieval, and selecting S3 again resumes from the newest committed local archive state.

Lazy retrieval verifies encoded transport bytes and the uncompressed logical SHA-256 before atomically reinstalling an object into local CAS. `/hoarder prune` is available only while S3 is selected and removes only exact durable verified receipt-backed local CAS objects after confirmation when UI is available. Prune does not perform a restore round trip first; removed objects become remote-only, and R1 currently has no in-product restore command.

S3 credentials and routing are configured globally. Credentials use the AWS SDK credential chain; project configuration and catalogs never contain credentials and cannot redirect uploads.

### 4.3 Git-tracked project catalogs

For a trusted Git worktree, enable direct source provenance explicitly:

```text
/hoarder git enable
```

After a verified local checkpoint—or after matching S3 publication when S3 is selected—Hoarder atomically writes:

```text
.pi/session-hoarder/catalog/<session-id>.json
```

The projection contains logical object identities, sizes, allowlisted artifact relations, structural Git context, and verified local/S3 location descriptors. It excludes session content, prompts, absolute paths, credentials, configured endpoints, credential profiles, and private operational errors.

The file appears as an ordinary worktree change. Hoarder never stages, commits, amends, installs hooks, or changes the Git index. Commit the projection with the related source changes when you want the source commit or pull request to retain direct provenance to that session revision. Catalog files received from another branch or pull request are untrusted; remote retrieval is allowed only through a matching globally configured target.

## 5. Configuration

Configuration is optional. Global settings are read from:

```text
~/.pi/agent/session-hoarder.json
```

If `PI_CODING_AGENT_DIR` is set, the global configuration file is read from that Pi agent directory instead.

```json
{
  "enabled": true,
  "debounceMs": 30000,
  "shutdownTimeoutMs": 3000,
  "retrievalConfirmationBytes": 104857600,
  "storageRoot": "~/.pi/agent/session-hoarder",
  "storageTarget": "local"
}
```

| Setting | Description |
| --- | --- |
| `enabled` | Enables or disables collection |
| `debounceMs` | Delay used to coalesce normal session updates |
| `shutdownTimeoutMs` | Maximum time allowed for the final shutdown checkpoint |
| `retrievalConfirmationBytes` | Encoded-byte threshold above which explicit lazy retrieval requires confirmation |
| `storageRoot` | Location of the local content-addressed archive |
| `storageTarget` | Selected durability target: `local` or `s3` |
| `s3` | Global-only named S3 target settings used when `storageTarget` is `s3` |

A global S3 target uses this shape:

```json
{
  "storageTarget": "s3",
  "s3": {
    "targetId": "backup",
    "bucket": "private-pi-sessions",
    "region": "us-east-1",
    "prefix": "session-hoarder",
    "forcePathStyle": false,
    "serverSideEncryption": "AES256"
  }
}
```

Optional S3 fields include `endpoint`, `profile`, and `kmsKeyId`. Credentials are resolved externally and are never stored in Session Hoarder configuration.

Trusted projects may also provide `.pi/session-hoarder.json`, but project configuration may only change `enabled`, `debounceMs`, `shutdownTimeoutMs`, and `gitCatalogEnabled`. A project cannot redirect the archive location or remote target, and configuration from untrusted projects is ignored.

Invalid configuration disables collection and reports an error instead of crashing Pi.

## 6. Privacy and current scope

Pi sessions can contain prompts, model responses, source code, file paths, embedded images, tool results, and secrets. Bash full-output sidecars may contain substantially more data than the truncated output shown in the conversation.

Treat the archive directory as sensitive data and protect it accordingly.

Remote durability is opt-in and requires a globally configured S3-compatible target. R1 has no automatic retention policy, never deletes source session JSONL or remote objects, and does not provide a general automated restore command. Local cache pruning is always explicit and receipt-gated.

## 7. Contributing

Contributions and issue reports are welcome. To work on the extension locally:

```bash
npm ci
pi -e ./src/index.ts
npm run format
npm run lint
npm run test:coverage
npm run analyze
npm run analyze:audit -- --base origin/main
npm run check
```

`npm run format` applies Oxfmt to TypeScript, JavaScript, JSON, and JSONC project files. `npm run lint` runs Oxlint with correctness, suspicious-code, performance, TypeScript, import, Node, promise, Unicorn, and Vitest checks. `npm run check` first verifies formatting and linting, then typechecks the project, runs the full test suite with Istanbul coverage, enforces coverage thresholds, and runs Fallow's type-aware dead-code, duplication, architecture, and maintainability gates. The current minimum coverage is 85% statements, 75% branches, 90% functions, and 90% lines.

Reusable adapter behavior lives under `test/contracts/`, while deterministic interruption tests use failpoints under `test/support/`. New object-store and Unit of Work adapters should pass the same contracts as the local filesystem implementations.

Runtime code uses TypeScript, Node built-ins, and Pi-provided APIs. Please include tests with behavioral changes and keep dependencies flowing through the existing `domain`, `application`, `adapters`, and `entrypoints` layers. The project is licensed under Apache-2.0.
