import { Type } from "typebox";
import * as Value from "typebox/value";

import {
  UTC_TIMESTAMP_PATTERN,
  type SessionArchiveRecord,
} from "../../domain/model.js";

const Sha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const UtcTimestampSchema = Type.String({ pattern: UTC_TIMESTAMP_PATTERN });
const ObjectReferenceSchema = Type.Object(
  {
    algorithm: Type.Literal("sha256"),
    digest: Sha256Schema,
    encoding: Type.Literal("gzip"),
    logicalBytes: Type.Integer({ minimum: 0 }),
    storedBytes: Type.Integer({ minimum: 0 }),
    relativePath: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
const ArtifactRelationSchema = Type.Object(
  {
    kind: Type.Literal("pi-bash-full-output"),
    sourceEntryId: Type.String({ minLength: 1 }),
    sourceField: Type.Literal("message.details.fullOutputPath"),
    state: Type.Union([
      Type.Literal("captured"),
      Type.Literal("missing"),
      Type.Literal("invalid"),
    ]),
    object: Type.Optional(ObjectReferenceSchema),
    warning: Type.Optional(Type.String()),
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
const SessionArchiveRecordSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
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
    artifacts: Type.Array(ArtifactRelationSchema),
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
  assertSessionArchiveRecord(value, location);
  return value;
}

export function encodeSessionArchiveRecord(record: SessionArchiveRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

function assertSessionArchiveRecord(
  value: unknown,
  location: string,
): asserts value is SessionArchiveRecord {
  if (Value.Check(SessionArchiveRecordSchema, value)) return;
  const first = Value.Errors(SessionArchiveRecordSchema, value)[0];
  const detail = first
    ? `${first.instancePath || "/"}: ${first.message}`
    : "unknown validation error";
  throw new Error(`Invalid session archive record at ${location}: ${detail}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
