import { Type, type TSchema } from "typebox";
import * as Value from "typebox/value";

import {
  UTC_TIMESTAMP_PATTERN,
  type ArtifactRelation,
  type ObjectReference,
  type SessionArchiveRecord,
} from "../../domain/model.js";
import { ObjectReferenceProperties, ObjectReferenceSchema } from "./object-reference-schema.js";

interface V1ObjectReference extends ObjectReference {
  relativePath: string;
}

interface V1ArtifactRelation extends Omit<ArtifactRelation, "object"> {
  object?: V1ObjectReference;
}

interface V1SessionArchiveRecord extends Omit<
  SessionArchiveRecord,
  "schemaVersion" | "sessionObject" | "artifacts"
> {
  schemaVersion: 1;
  sessionObject: V1ObjectReference;
  artifacts: readonly V1ArtifactRelation[];
}

const Sha256Schema = ObjectReferenceProperties.digest;
const UtcTimestampSchema = Type.String({ pattern: UTC_TIMESTAMP_PATTERN });
const V1ObjectReferenceSchema = Type.Object(
  {
    ...ObjectReferenceProperties,
    relativePath: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
const CheckpointErrorSchema = Type.Object(
  {
    code: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
    occurredAt: UtcTimestampSchema,
    retryable: Type.Boolean(),
  },
  { additionalProperties: false },
);
const SessionArchiveRecordSchema = sessionArchiveRecordSchema(2, ObjectReferenceSchema);
const V1SessionArchiveRecordSchema = sessionArchiveRecordSchema(1, V1ObjectReferenceSchema);

export function decodeSessionArchiveRecord(text: string, location: string): SessionArchiveRecord {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Archive catalog ${location} contains invalid JSON: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  const schemaVersion = readSchemaVersion(value);
  if (schemaVersion === 1) {
    assertSchema(V1SessionArchiveRecordSchema, value, location);
    return migrateV1Record(value as unknown as V1SessionArchiveRecord);
  }
  if (schemaVersion === 2) {
    assertSchema(SessionArchiveRecordSchema, value, location);
    return value as unknown as SessionArchiveRecord;
  }
  throw new Error(
    `Invalid session archive record at ${location}: /schemaVersion: unsupported schema version ${JSON.stringify(schemaVersion)}.`,
  );
}

export function encodeSessionArchiveRecord(record: SessionArchiveRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

function sessionArchiveRecordSchema(schemaVersion: 1 | 2, objectSchema: TSchema): TSchema {
  return Type.Object(
    {
      schemaVersion: Type.Literal(schemaVersion),
      repositoryId: Type.String({ minLength: 1 }),
      sessionId: Type.String({ minLength: 1 }),
      revision: Type.Integer({ minimum: 1 }),
      source: Type.Object(
        {
          size: Type.Integer({ minimum: 0 }),
          mtimeMs: Type.Number({ minimum: 0 }),
          sha256: Sha256Schema,
        },
        { additionalProperties: false },
      ),
      sessionObject: objectSchema,
      artifacts: Type.Array(artifactRelationSchema(objectSchema)),
      capturedAt: UtcTimestampSchema,
      lastVerifiedAt: UtcTimestampSchema,
      lastError: Type.Optional(CheckpointErrorSchema),
    },
    { additionalProperties: false },
  );
}

function artifactRelationSchema(objectSchema: TSchema): TSchema {
  return Type.Object(
    {
      kind: Type.Literal("pi-bash-full-output"),
      sourceEntryId: Type.String({ minLength: 1 }),
      sourceField: Type.Literal("message.details.fullOutputPath"),
      state: Type.Union([
        Type.Literal("captured"),
        Type.Literal("missing"),
        Type.Literal("invalid"),
      ]),
      object: Type.Optional(objectSchema),
      warning: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  );
}

function migrateV1Record(record: V1SessionArchiveRecord): SessionArchiveRecord {
  return {
    ...record,
    schemaVersion: 2,
    sessionObject: migrateV1Object(record.sessionObject),
    artifacts: record.artifacts.map((artifact) => ({
      ...artifact,
      object: artifact.object ? migrateV1Object(artifact.object) : undefined,
    })),
  };
}

function migrateV1Object(object: V1ObjectReference): ObjectReference {
  const { relativePath: _relativePath, ...logicalReference } = object;
  return logicalReference;
}

function assertSchema(
  schema: TSchema,
  value: unknown,
  location: string,
): asserts value is Record<string, unknown> {
  if (Value.Check(schema, value)) return;
  const first = Value.Errors(schema, value)[0];
  const detail = first
    ? `${first.instancePath || "/"}: ${first.message}`
    : "unknown validation error";
  throw new Error(`Invalid session archive record at ${location}: ${detail}`);
}

function readSchemaVersion(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return (value as { schemaVersion?: unknown }).schemaVersion;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
