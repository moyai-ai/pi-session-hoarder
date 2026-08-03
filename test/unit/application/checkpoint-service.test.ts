import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { CheckpointApplicationService } from "../../../src/application/checkpoint-service.js";
import type {
  ArtifactDiscovery,
  CapturedSessionSnapshot,
  CheckpointUnitOfWork,
  CheckpointUnitOfWorkFactory,
  ObjectStore,
  SessionArchiveRepository,
  SessionSnapshotter,
  SourceBoundary,
} from "../../../src/application/ports.js";
import { SessionArchive, type ObjectReference } from "../../../src/domain/model.js";

class FakeArchiveRepository implements SessionArchiveRepository {
  stored?: SessionArchive;
  staged?: SessionArchive;

  async get(): Promise<SessionArchive | undefined> {
    return this.stored;
  }

  add(archive: SessionArchive): void {
    this.staged = archive;
  }
}

class FakeObjectStore implements ObjectStore {
  readonly paths = new Map<string, ObjectReference>();
  readonly available = new Set<string>();

  addPath(path: string, contents: string): ObjectReference {
    const digest = createHash("sha256").update(contents).digest("hex");
    const object: ObjectReference = {
      algorithm: "sha256",
      digest,
      encoding: "gzip",
      logicalBytes: contents.length,
      storedBytes: contents.length,
      relativePath: `objects/${digest}.gz`,
    };
    this.paths.set(path, object);
    return object;
  }

  async putFile(path: string) {
    const object = this.paths.get(path);
    if (!object) throw new Error(`missing fake path ${path}`);
    this.available.add(object.digest);
    return { object, absolutePath: path };
  }

  async has(digest: string): Promise<boolean> {
    return this.available.has(digest);
  }

  async verify(object: ObjectReference) {
    return { valid: this.available.has(object.digest), digest: object.digest, logicalBytes: object.logicalBytes };
  }
}

class FakeUnitOfWork implements CheckpointUnitOfWork {
  committed = false;
  rolledBack = false;
  disposed = false;

  constructor(
    readonly archives: FakeArchiveRepository,
    readonly objects: FakeObjectStore,
  ) {}

  async commit(): Promise<void> {
    if (!this.archives.staged) throw new Error("nothing staged");
    this.archives.stored = this.archives.staged;
    this.archives.staged = undefined;
    this.committed = true;
  }

  async rollback(): Promise<void> {
    this.archives.staged = undefined;
    this.rolledBack = true;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

class FakeUnitOfWorkFactory implements CheckpointUnitOfWorkFactory {
  readonly archives = new FakeArchiveRepository();
  readonly objects = new FakeObjectStore();
  created: FakeUnitOfWork[] = [];

  create(): CheckpointUnitOfWork {
    const uow = new FakeUnitOfWork(this.archives, this.objects);
    this.created.push(uow);
    return uow;
  }
}

class FakeSnapshotter implements SessionSnapshotter {
  boundary?: SourceBoundary = { size: 100, mtimeMs: 1 };
  disposed = false;

  async inspect(): Promise<SourceBoundary | undefined> {
    return this.boundary;
  }

  async capture(
    _sourcePath: string,
    boundary: SourceBoundary,
  ): Promise<CapturedSessionSnapshot> {
    return {
      path: "snapshot",
      sourcePath: "session",
      ...boundary,
      dispose: async () => {
        this.disposed = true;
      },
    };
  }
}

function setup(artifactDiscovery: ArtifactDiscovery = { discover: async () => [] }) {
  const unitOfWorkFactory = new FakeUnitOfWorkFactory();
  const snapshotter = new FakeSnapshotter();
  unitOfWorkFactory.objects.addPath("snapshot", "session bytes");
  const service = new CheckpointApplicationService({
    unitOfWorkFactory,
    snapshotter,
    artifactDiscovery,
    clock: { now: () => new Date("2026-08-03T12:00:00.000Z") },
  });
  return { service, unitOfWorkFactory, snapshotter };
}

const command = { repositoryId: "repo", sessionId: "session", sessionFile: "session" };

describe("checkpoint application service", () => {
  it("coordinates repositories and commits one aggregate", async () => {
    const { service, unitOfWorkFactory, snapshotter } = setup();

    const result = await service.checkpoint(command);

    expect(result).toMatchObject({ changed: true, record: { revision: 1 } });
    expect(unitOfWorkFactory.created[0]).toMatchObject({ committed: true, disposed: true });
    expect(snapshotter.disposed).toBe(true);
    expect(unitOfWorkFactory.archives.stored?.record).toEqual(result?.record);
  });

  it("rolls back without snapshotting or hashing an unchanged source", async () => {
    const { service, unitOfWorkFactory, snapshotter } = setup();
    const first = await service.checkpoint(command);
    snapshotter.disposed = false;

    const second = await service.checkpoint(command);

    expect(second).toEqual({ changed: false, record: first?.record });
    expect(unitOfWorkFactory.created[1]).toMatchObject({ rolledBack: true, committed: false });
    expect(snapshotter.disposed).toBe(false);
  });

  it("treats a not-yet-persisted Pi session as a safe no-op", async () => {
    const { service, unitOfWorkFactory, snapshotter } = setup();
    snapshotter.boundary = undefined;

    await expect(service.checkpoint(command)).resolves.toBeUndefined();
    expect(unitOfWorkFactory.created[0]).toMatchObject({ rolledBack: true, disposed: true });
  });

  it("captures sidecars while preserving their source relations", async () => {
    const discovery: ArtifactDiscovery = {
      discover: async () => [
        {
          path: "sidecar",
          relation: {
            kind: "pi-bash-full-output",
            sourceEntryId: "entry",
            sourceField: "message.details.fullOutputPath",
            state: "captured",
          },
        },
      ],
    };
    const { service, unitOfWorkFactory } = setup(discovery);
    const sidecar = unitOfWorkFactory.objects.addPath("sidecar", "full output");

    const result = await service.checkpoint(command);

    expect(result?.record.artifacts).toEqual([
      {
        kind: "pi-bash-full-output",
        sourceEntryId: "entry",
        sourceField: "message.details.fullOutputPath",
        state: "captured",
        object: sidecar,
      },
    ]);
  });

  it("rolls back aggregate publication on failure", async () => {
    const { service, unitOfWorkFactory } = setup({
      discover: async () => {
        throw new Error("corrupt session");
      },
    });

    await expect(service.checkpoint(command)).rejects.toThrow("corrupt session");
    expect(unitOfWorkFactory.created[0]).toMatchObject({ rolledBack: true, disposed: true });
    expect(unitOfWorkFactory.archives.stored).toBeUndefined();
  });
});
