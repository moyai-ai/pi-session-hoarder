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

## Install

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

## Using Session Hoarder

Most of the time, no interaction is necessary. A compact footer indicator shows the current state:

| Indicator | Meaning |
| --- | --- |
| `◇hoard` | The archive is current |
| `↑1 hoard` | A checkpoint is pending |
| `⠋hoard` | A checkpoint is running (animated spinner) |
| `!hoard` | Initialization or the last checkpoint failed |
| `○hoard off` | Hoarder is disabled or the session is not persisted |

Two commands are available:

```text
/hoarder status
/hoarder sync
```

`/hoarder status` reports the active session, storage location, catalog revision, archive sizes, captured artifact count, and last error when applicable.

`/hoarder sync` requests an immediate checkpoint instead of waiting for the normal debounce interval.

## What is archived

For each persisted Pi session, Hoarder captures:

1. The active Pi JSONL session file at a stable boundary.
2. Full Bash output files explicitly referenced by Pi at `message.details.fullOutputPath`.

Sidecar discovery is intentionally allowlisted. Hoarder does not follow arbitrary paths from model messages or tool output, recursively scan directories, or archive project files.

Missing Bash sidecars are recorded as warnings and do not prevent the session itself from being archived.

## Storage

The default archive is stored at:

```text
~/.pi/agent/session-hoarder/
  objects/sha256/<hash>.gz
  catalog/<repo-id>/<session-id>.json
  tmp/
```

Session and sidecar bytes are streamed through SHA-256 and gzip. The SHA-256 identity is calculated from the original, uncompressed content; gzip is only the storage encoding. Catalog revisions are published atomically only after every referenced object exists.

Repository identities keep sessions from different projects separate. Git repositories use their normalized `origin` URL when available, then their repository root; directories outside Git use their canonical working path.

The archive uses ordinary JSON catalogs and gzip files rather than a proprietary format. There is not yet a built-in restore command, but each catalog identifies its session object through `sessionObject.relativePath`. You can decode that object with standard gzip tooling:

```bash
gzip -dc ~/.pi/agent/session-hoarder/<relative-path-from-catalog> > recovered-session.jsonl
```

## Configuration

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
  "storageRoot": "~/.pi/agent/session-hoarder"
}
```

| Setting | Description |
| --- | --- |
| `enabled` | Enables or disables collection |
| `debounceMs` | Delay used to coalesce normal session updates |
| `shutdownTimeoutMs` | Maximum time allowed for the final shutdown checkpoint |
| `storageRoot` | Location of the local content-addressed archive |

Trusted projects may also provide `.pi/session-hoarder.json`, but project configuration may only change `enabled`, `debounceMs`, and `shutdownTimeoutMs`. A project cannot redirect the archive location, and configuration from untrusted projects is ignored.

Invalid configuration disables collection and reports an error instead of crashing Pi.

## Privacy and current scope

Pi sessions can contain prompts, model responses, source code, file paths, embedded images, tool results, and secrets. Bash full-output sidecars may contain substantially more data than the truncated output shown in the conversation.

Treat the archive directory as sensitive data and protect it accordingly.

The current release is deliberately local-only. It does **not** upload data, replicate to remote storage, apply retention policies, delete source sessions, or provide an automated restore workflow. Because the archive normally lives on the same machine, it is not a replacement for an encrypted off-device backup.

## Contributing

Contributions and issue reports are welcome. To work on the extension locally:

```bash
npm ci
pi -e ./src/index.ts
npm run test:coverage
npm run analyze
npm run analyze:audit -- --base origin/main
npm run check
```

`npm run check` typechecks the project, runs the full test suite with Istanbul coverage, enforces coverage thresholds, and runs Fallow's type-aware dead-code, duplication, architecture, and maintainability gates. The current minimum coverage is 85% statements, 75% branches, 90% functions, and 90% lines.

Reusable adapter behavior lives under `test/contracts/`, while deterministic interruption tests use failpoints under `test/support/`. New object-store and Unit of Work adapters should pass the same contracts as the local filesystem implementations.

Runtime code uses TypeScript, Node built-ins, and Pi-provided APIs. Please include tests with behavioral changes and keep dependencies flowing through the existing `domain`, `application`, `adapters`, and `entrypoints` layers. The project is licensed under Apache-2.0.
