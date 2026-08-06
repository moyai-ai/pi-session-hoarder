import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { CheckpointApplicationService } from "../../../src/application/checkpoint-service.js";
import type {
  ArtifactDiscovery,
  CapturedSessionSnapshot,
  CheckpointUnitOfWork,
  CheckpointUnitOfWorkFactory,
  DiscoveredArtifact,
  ObjectStore,
  SessionArchiveRepository,
  SessionSnapshotter,
  SourceBoundary,
} from "../../../src/application/ports.js";
import { SessionArchive, type ObjectReference } from "../../../src/domain/model.js";
import { Failpoints } from "../../support/failpoints.js";

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

  constructor(private readonly failpoints: Failpoints) {}

  addPath(path: string, contents: string): ObjectReference {
    const digest = createHash("sha256").update(contents).digest("hex");
    const object: ObjectReference = {
      algorithm: "sha256",
      digest,
      encoding: "gzip",
      logicalBytes: contents.length,
      storedBytes: contents.length,
    };
    this.paths.set(path, object);
    return object;
  }

  async putFile(path: string) {
    this.failpoints.hit(`object:put:${path}`);
    const object = this.paths.get(path);
    if (!object) throw new Error(`missing fake path ${path}`);
    this.available.add(object.digest);
    return { object, absolutePath: path };
  }

  async has(digest: string): Promise<boolean> {
    return this.available.has(digest);
  }

  async verify(object: ObjectReference) {
    this.failpoints.hit("object:verify");
    return {
      valid: this.available.has(object.digest),
      digest: object.digest,
      logicalBytes: object.logicalBytes,
    };
  }
}

class FakeUnitOfWork implements CheckpointUnitOfWork {
  committed = false;
  rolledBack = false;
  disposed = false;

  constructor(
    readonly archives: FakeArchiveRepository,
    readonly objects: FakeObjectStore,
    private readonly failpoints: Failpoints,
  ) {}

  async commit(): Promise<void> {
    this.failpoints.hit("uow:commit");
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
  readonly objects: FakeObjectStore;
  created: FakeUnitOfWork[] = [];

  constructor(private readonly failpoints: Failpoints) {
    this.objects = new FakeObjectStore(failpoints);
  }

  create(): CheckpointUnitOfWork {
    const uow = new FakeUnitOfWork(this.archives, this.objects, this.failpoints);
    this.created.push(uow);
    return uow;
  }
}

class FakeSnapshotter implements SessionSnapshotter {
  boundary?: SourceBoundary = { size: 100, mtimeMs: 1 };
  disposed = false;

  constructor(private readonly failpoints: Failpoints) {}

  async inspect(): Promise<SourceBoundary | undefined> {
    this.failpoints.hit("snapshot:inspect");
    return this.boundary;
  }

  async capture(_sourcePath: string, boundary: SourceBoundary): Promise<CapturedSessionSnapshot> {
    this.failpoints.hit("snapshot:capture");
    return {
      path: "snapshot",
      sourcePath: "session",
      ...boundary,
      dispose: async () => {
        this.failpoints.hit("snapshot:dispose");
        this.disposed = true;
      },
    };
  }
}

function setup(
  artifactDiscovery: ArtifactDiscovery = { discover: async () => [] },
  failpoints = new Failpoints(),
) {
  const unitOfWorkFactory = new FakeUnitOfWorkFactory(failpoints);
  const snapshotter = new FakeSnapshotter(failpoints);
  unitOfWorkFactory.objects.addPath("snapshot", "session bytes");
  const service = new CheckpointApplicationService({
    unitOfWorkFactory,
    snapshotter,
    artifactDiscovery,
    clock: { now: () => new Date("2026-08-03T12:00:00.000Z") },
  });
  return { service, unitOfWorkFactory, snapshotter, failpoints };
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
            sourceState: "present",
            archiveState: "unavailable",
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
        sourceState: "present",
        archiveState: "captured",
        object: sidecar,
      },
    ]);
  });

  it.each(["missing", "invalid"] as const)(
    "preserves a previously captured object when the current source is %s",
    async (sourceState) => {
      let discovered: DiscoveredArtifact[] = [
        {
          path: "sidecar",
          relation: {
            kind: "pi-bash-full-output" as const,
            sourceEntryId: "entry",
            sourceField: "message.details.fullOutputPath" as const,
            sourceState: "present" as const,
            archiveState: "unavailable" as const,
          },
        },
      ];
      const { service, unitOfWorkFactory, snapshotter } = setup({
        discover: async () => discovered,
      });
      const sidecar = unitOfWorkFactory.objects.addPath("sidecar", "full output");
      await service.checkpoint(command);
      snapshotter.boundary = { size: 101, mtimeMs: 2 };
      discovered = [
        {
          relation: {
            kind: "pi-bash-full-output",
            sourceEntryId: "entry",
            sourceField: "message.details.fullOutputPath",
            sourceState,
            archiveState: "unavailable",
            warning: "current source unavailable",
          },
        },
      ];

      const result = await service.checkpoint(command);

      expect(result?.record.artifacts).toEqual([
        {
          kind: "pi-bash-full-output",
          sourceEntryId: "entry",
          sourceField: "message.details.fullOutputPath",
          sourceState,
          archiveState: "captured",
          object: sidecar,
          warning: "current source unavailable",
        },
      ]);
    },
  );

  it("preserves a previous object after a transient capture failure", async () => {
    let path = "sidecar";
    const { service, unitOfWorkFactory, snapshotter } = setup({
      discover: async () => [
        {
          path,
          relation: {
            kind: "pi-bash-full-output",
            sourceEntryId: "entry",
            sourceField: "message.details.fullOutputPath",
            sourceState: "present",
            archiveState: "unavailable",
          },
        },
      ],
    });
    const sidecar = unitOfWorkFactory.objects.addPath("sidecar", "full output");
    await service.checkpoint(command);
    snapshotter.boundary = { size: 101, mtimeMs: 2 };
    path = "transiently-unreadable";

    const result = await service.checkpoint(command);

    expect(result?.record.artifacts[0]).toMatchObject({
      sourceState: "present",
      archiveState: "captured",
      object: sidecar,
      warning: expect.stringContaining("Unable to capture Bash full output"),
    });
  });

  it("prefers newly captured content for the same relation and drops removed relations", async () => {
    let discovered = [
      {
        path: "old-sidecar",
        relation: {
          kind: "pi-bash-full-output" as const,
          sourceEntryId: "entry",
          sourceField: "message.details.fullOutputPath" as const,
          sourceState: "present" as const,
          archiveState: "unavailable" as const,
        },
      },
    ];
    const { service, unitOfWorkFactory, snapshotter } = setup({
      discover: async () => discovered,
    });
    const oldSidecar = unitOfWorkFactory.objects.addPath("old-sidecar", "old output");
    const newSidecar = unitOfWorkFactory.objects.addPath("new-sidecar", "new output");
    await service.checkpoint(command);
    snapshotter.boundary = { size: 101, mtimeMs: 2 };
    discovered = [{ ...discovered[0]!, path: "new-sidecar" }];

    const changed = await service.checkpoint(command);

    expect(changed?.record.artifacts[0]?.object).toEqual(newSidecar);
    expect(changed?.record.artifacts[0]?.object).not.toEqual(oldSidecar);
    snapshotter.boundary = { size: 102, mtimeMs: 3 };
    discovered = [];

    const removed = await service.checkpoint(command);

    expect(removed?.record.artifacts).toEqual([]);
  });

  it("does not invent an object for a never-captured missing relation", async () => {
    const { service } = setup({
      discover: async () => [
        {
          relation: {
            kind: "pi-bash-full-output",
            sourceEntryId: "entry",
            sourceField: "message.details.fullOutputPath",
            sourceState: "missing",
            archiveState: "unavailable",
            warning: "not found",
          },
        },
      ],
    });

    const result = await service.checkpoint(command);

    expect(result?.record.artifacts[0]).toMatchObject({
      sourceState: "missing",
      archiveState: "unavailable",
    });
    expect(result?.record.artifacts[0]).not.toHaveProperty("object");
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

  it.each([
    "snapshot:inspect",
    "snapshot:capture",
    "artifact:discover",
    "object:put:snapshot",
    "object:verify",
    "uow:commit",
  ])("preserves aggregate invisibility after an injected %s failure", async (phase) => {
    const failpoints = new Failpoints();
    const discovery: ArtifactDiscovery = {
      discover: async () => {
        failpoints.hit("artifact:discover");
        return [];
      },
    };
    const { service, unitOfWorkFactory } = setup(discovery, failpoints);
    failpoints.arm(phase);

    await expect(service.checkpoint(command)).rejects.toThrow(`Injected failure at ${phase}`);
    expect(unitOfWorkFactory.created[0]).toMatchObject({ rolledBack: true, disposed: true });
    expect(unitOfWorkFactory.archives.stored).toBeUndefined();
  });

  it("disposes the Unit of Work even when snapshot cleanup fails", async () => {
    const failpoints = new Failpoints();
    const { service, unitOfWorkFactory } = setup(undefined, failpoints);
    failpoints.arm("snapshot:dispose");

    await expect(service.checkpoint(command)).rejects.toThrow(
      "Injected failure at snapshot:dispose",
    );
    expect(unitOfWorkFactory.created[0]).toMatchObject({ committed: true, disposed: true });
  });
});
