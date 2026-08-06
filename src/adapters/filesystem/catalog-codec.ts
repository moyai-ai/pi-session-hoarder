import { Type, type TSchema } from "typebox";
import * as Value from "typebox/value";

import { UTC_TIMESTAMP_PATTERN, type SessionArchiveRecord } from "../../domain/model.js";
import { ObjectReferenceProperties, ObjectReferenceSchema } from "./object-reference-schema.js";

const Sha256Schema = ObjectReferenceProperties.digest;
const UtcTimestampSchema = Type.String({ pattern: UTC_TIMESTAMP_PATTERN });
const CheckpointErrorSchema = Type.Object(
  {
    code: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
    occurredAt: UtcTimestampSchema,
    retryable: Type.Boolean(),
  },
  { additionalProperties: false },
);
const SessionArchiveRecordSchema = Type.Object(
  {
    schemaVersion: Type.Literal(3),
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
    sessionObject: ObjectReferenceSchema,
    artifacts: Type.Array(artifactRelationSchema(ObjectReferenceSchema)),
    capturedAt: UtcTimestampSchema,
    lastVerifiedAt: UtcTimestampSchema,
    lastError: Type.Optional(CheckpointErrorSchema),
  },
  { additionalProperties: false },
);

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
  if (schemaVersion !== 3) {
    throw new Error(
      `Invalid session archive record at ${location}: /schemaVersion: unsupported schema version ${JSON.stringify(schemaVersion)}.`,
    );
  }
  assertSchema(SessionArchiveRecordSchema, value, location);
  return value as unknown as SessionArchiveRecord;
}

export function encodeSessionArchiveRecord(record: SessionArchiveRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

function artifactRelationBase() {
  return {
    kind: Type.Literal("pi-bash-full-output"),
    sourceEntryId: Type.String({ minLength: 1 }),
    sourceField: Type.Literal("message.details.fullOutputPath"),
    sourceState: Type.Union([
      Type.Literal("present"),
      Type.Literal("missing"),
      Type.Literal("invalid"),
    ]),
    warning: Type.Optional(Type.String()),
  };
}

function artifactRelationSchema(objectSchema: TSchema): TSchema {
  return Type.Union([
    Type.Object(
      {
        ...artifactRelationBase(),
        archiveState: Type.Literal("captured"),
        object: objectSchema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        ...artifactRelationBase(),
        archiveState: Type.Literal("unavailable"),
      },
      { additionalProperties: false },
    ),
  ]);
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
