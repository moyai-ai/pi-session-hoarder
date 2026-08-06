<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/moyai-ai/pi-session-hoarder/main/assets/moyai-logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/moyai-ai/pi-session-hoarder/main/assets/moyai-logo.svg">
    <img src="https://raw.githubusercontent.com/moyai-ai/pi-session-hoarder/main/assets/moyai-logo.svg" alt="Moyai logo" width="240">
  </picture>
</p>

<h1 align="center">🐿️ Pi Session Hoarder</h1>

<p align="center"><strong>Verified local archives for your Pi sessions.</strong></p>

**Pi Session Hoarder** (**Hoarder**) is a zero-configuration [Pi](https://github.com/earendil-works/pi-mono) extension that automatically archives every persisted Pi session into verified local storage. Hoarder gives you a durable history of your Pi work without changing how Pi writes or manages sessions:

- **Automatic checkpoints** — Hoarder archives the session in the background as it evolves.
- **Crash recovery** — when a session restarts, Hoarder detects missed work and checkpoints it.
- **Complete Bash output** — Hoarder preserves the full Bash output files Pi references from a session (**sidecars**), so long command output survives even when the chat shows only a truncated version.
- **Verified storage** — Hoarder names every archived object by the SHA-256 hash of its original bytes, so the archive can prove its contents are intact.
- **Efficient storage** — Hoarder stores identical content once and compresses everything with gzip.
- **Safe by design** — Hoarder never replaces, truncates, or deletes Pi's own session files.

Pi's JSONL session file remains the live journal that Pi itself writes. Hoarder adds a second, independent copy: it streams each checkpoint into `~/.pi/agent/session-hoarder/` and can optionally replicate the same objects to S3. Hoarder never takes over Pi persistence.

## 1. Install

Install the npm release with Pi:

```bash
pi install npm:@moyai/pi-session-hoarder
```

Restart Pi, or run `/reload` in your current session, to activate Hoarder. From then on it works automatically whenever a persisted session starts—no configuration, no separate background service.

> Pi extensions run with your system permissions. Review third-party extension source before you install it.

## 2. Using Hoarder

Most of the time you won't need to touch Hoarder. A compact footer indicator shows its state:

| Indicator | Meaning |
| --- | --- |
| `◇hoard` | The archive is current |
| `↑1 hoard` | A checkpoint is pending |
| `⠋hoard` | A checkpoint is running (animated spinner) |
| `!hoard` | Initialization or the last checkpoint failed |
| `○hoard off` | Hoarder is disabled or the session is not persisted |

Hoarder adds the following commands:

- `/hoarder status` reports the active session, selected storage target, catalog revisions, archive sizes, captured artifact count, and the last error if one occurred.
- `/hoarder sync` checkpoints immediately instead of waiting for the normal update delay.
- `/hoarder git enable` turns on Git-tracked session catalogs for a trusted worktree ([section 4.3](#43-git-tracked-project-catalogs)).
- `/hoarder storage local` and `/hoarder storage s3` select the storage target ([section 4](#4-storage)).
- `/hoarder prune` frees local disk space that S3 already holds safely ([section 4.2.4](#424-pruning)).

## 3. What Hoarder archives

For each persisted Pi session, Hoarder captures:

- The Pi JSONL session file, taken at a stable boundary.
- The full Bash output sidecars that Pi references at `message.details.fullOutputPath`.

Hoarder follows only that explicit allowlist: it never follows arbitrary paths from model messages or tool output, never scans directories recursively, and never archives project files. If a sidecar is missing, Hoarder records a warning and archives the session anyway.

## 4. Storage

### 4.1 Local storage

Local storage is the zero-configuration default, and it remains the first write path even when S3 is enabled: every checkpoint lands in the local archive first.

```text
~/.pi/agent/session-hoarder/
  objects/sha256/<hash>.gz
  catalog/<repo-id>/<session-id>.json
  tmp/
```

The archive is content-addressed: Hoarder streams session and sidecar bytes through SHA-256 and gzip, names each object by the hash of its original uncompressed bytes, and stores identical content only once. A **catalog** is a small JSON file that lists the objects making up one archived session; Hoarder publishes each catalog revision atomically, and only after every object it references exists.

Catalogs for sessions from different projects remain separate. Hoarder keys each archive by repository identity: a Git repository's normalized `origin` URL when available, otherwise its repository root; directories outside Git use their canonical working path.

Hoarder has no restore command yet, but the local archive needs no special tooling to read. Each catalog names its session object in `sessionObject.digest`, the object lives at `objects/sha256/<digest>.gz`, and standard gzip decodes it:

```bash
gzip -dc ~/.pi/agent/session-hoarder/objects/sha256/<digest>.gz > recovered-session.jsonl
```

Catalogs store portable object references—never machine-specific paths—and Hoarder validates their schema strictly when it reads them.

### 4.2 S3 storage

S3 is optional replication, not a replacement: the local archive stays the checkpoint and staging path, and Hoarder copies verified gzip objects to your bucket in the background. Select it with:

```text
/hoarder storage s3
```

#### 4.2.1 Setup wizard

When no valid target exists and a UI is available, the command opens a short setup wizard. The wizard:

- Asks for the bucket, region, and credential source. A target name and object prefix are optional; custom endpoints and path-style addressing appear only for S3-compatible services such as MinIO or RustFS.
- Shows a sanitized summary of the target and the exact upload size of the current session, and warns that private session and sidecar bytes will leave your machine.
- Offers two ways to finish: test-upload and verify the current session objects before saving the target, or save without a test and let the first normal sync verify them.

A successful test upload is not repeated work: the first sync afterward re-verifies the remote bytes under the selected target identity but does not upload them again.

#### 4.2.2 Credentials and privacy

Routing is configured globally. Credentials resolve through the standard AWS credential chain; Hoarder never stores them in project configuration or catalogs, and project content cannot redirect uploads.

The wizard never asks for access keys, secrets, session tokens, or web-identity tokens. Supported credential sources include:

- **IAM user keys** — run `aws configure --profile session-hoarder` first, then select that profile; or export the standard AWS environment variables.
- **IAM Identity Center** — run `aws sso login --profile company-sso`, then select `company-sso`.
- **Workload roles or the default profile** — no profile entry is needed.

Uploads always use the bucket's encryption settings; Hoarder never sends a per-request encryption override. In headless print/JSON modes, the command asks nothing and makes no S3 requests—it prints the global configuration path instead.

#### 4.2.3 Replication and target switching

`/hoarder storage local` switches back safely. It cancels queued or active replication before saving the selection, and it touches nothing else:

- no new S3 requests;
- no downloads of remote-only history;
- no remote deletions; and
- no rewrites of committed project catalogs.

Selecting S3 again resumes from the newest committed local state.

#### 4.2.4 Pruning

`/hoarder prune` frees local disk space once S3 holds the data. It is available only while S3 is selected. After a preview and, when UI is available, your confirmation, it deletes exactly those local objects whose upload carries a durable, verified receipt—never source sessions, catalogs, receipts, configuration, or remote objects.

Prune trusts those exact receipts rather than re-downloading objects to check them. Pruned objects therefore become remote-only; with no in-product restore command yet, you must fetch and decompress them yourself if you need them back.

### 4.3 Git-tracked project catalogs

A trusted Git worktree can carry provenance for the sessions that produced it. Enable this explicitly:

```text
/hoarder git enable
```

After each verified local checkpoint—or after the matching S3 publication when S3 is selected—Hoarder atomically writes a catalog into the worktree:

```text
.pi/session-hoarder/catalog/<session-id>.json
```

The catalog contains logical object identities, sizes, allowlisted artifact relations, structural Git context, and location descriptors for the verified local and S3 copies. It excludes session content, prompts, absolute paths, credentials, endpoints, credential profiles, and operational error details.

The file appears as an ordinary worktree change, and Hoarder never stages, commits, amends, installs hooks, or touches the Git index. Commit the catalog alongside the related source changes when you want a commit or pull request to point at the exact session revision that produced it.

## 5. Configuration

Configuration is optional. Hoarder reads global settings from `~/.pi/agent/session-hoarder.json`, or from the Pi agent directory when `PI_CODING_AGENT_DIR` is set.

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

The following settings are available:

| Setting | Description |
| --- | --- |
| `enabled` | Master switch for collection |
| `debounceMs` | Delay that coalesces session updates into one checkpoint |
| `shutdownTimeoutMs` | Time limit for the final shutdown checkpoint |
| `retrievalConfirmationBytes` | Reserved confirmation threshold for the implemented retrieval service; no command uses retrieval yet |
| `storageRoot` | Location of the local archive |
| `storageTarget` | Active storage target: `local` or `s3` |
| `s3` | Named S3 target settings (global configuration only) |

A global S3 target uses this shape:

```json
{
  "storageTarget": "s3",
  "s3": {
    "targetId": "backup",
    "bucket": "private-pi-sessions",
    "region": "us-east-1",
    "prefix": "session-hoarder",
    "forcePathStyle": false
  }
}
```

`endpoint` and `profile` are optional S3 fields. Credentials resolve outside Hoarder—through the AWS credential chain—and never appear in Hoarder configuration. Hoarder does not support per-request encryption overrides; configure encryption on the bucket.

A trusted project may add its own `.pi/session-hoarder.json`, but project configuration can change only `enabled`, `debounceMs`, `shutdownTimeoutMs`, and `gitCatalogEnabled`. A project can never redirect the archive location or the remote target, and Hoarder ignores configuration from untrusted projects entirely.

Invalid configuration disables collection and reports an error instead of crashing Pi.

## 6. Privacy and current scope

Pi sessions can contain prompts, model responses, source code, file paths, embedded images, tool results, and secrets—and Bash sidecars may hold far more than the truncated output shown in the conversation. Treat the archive directory as sensitive data and protect it accordingly.

The current release also has deliberate limits:

- Remote replication is opt-in and requires a globally configured S3-compatible target.
- Hoarder ships no automatic retention policy and never deletes source session files or remote objects.
- Hoarder ships no automated restore command; locally available objects can be recovered with the standard tooling shown in [section 4.1](#41-local-storage).
- Pruning the local archive is always explicit and always backed by verified upload receipts.

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

`npm run format` applies Oxfmt to TypeScript, JavaScript, JSON, and JSONC files. `npm run lint` runs Oxlint with correctness, suspicious-code, performance, TypeScript, import, Node, promise, Unicorn, and Vitest rule sets. `npm run check` runs the full gate in order: format verification, lint, typecheck, the test suite with Istanbul coverage, coverage thresholds, then Fallow's type-aware dead-code, duplication, architecture, and maintainability analysis. Coverage must stay at or above 85% statements, 75% branches, 90% functions, and 90% lines.

Reusable adapter behavior lives under `test/contracts/`, and deterministic interruption tests use failpoints under `test/support/`. New object-store and Unit of Work adapters should pass the same contracts as the local filesystem implementations.

Runtime code uses TypeScript, Node built-ins, and Pi-provided APIs. Include tests with behavioral changes, and keep dependencies flowing through the existing `domain`, `application`, `adapters`, and `entrypoints` layers. Pi Session Hoarder is licensed under Apache-2.0.
