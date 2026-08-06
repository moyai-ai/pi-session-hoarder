import { Type } from "typebox";
import * as Value from "typebox/value";

import { UTC_TIMESTAMP_PATTERN } from "../../domain/model.js";
import type { SessionReplicaRecord } from "../../domain/replica.js";
import { ObjectReferenceSchema } from "./object-reference-schema.js";

const RemoteObjectReceiptSchema = Type.Object(
  {
    object: ObjectReferenceSchema,
    key: Type.String({ minLength: 1 }),
    etag: Type.Optional(Type.String({ minLength: 1 })),
    versionId: Type.Optional(Type.String({ minLength: 1 })),
    checksumSha256: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const SessionReplicaRecordSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    targetId: Type.String({ minLength: 1 }),
    repositoryId: Type.String({ minLength: 1 }),
    sessionId: Type.String({ minLength: 1 }),
    revision: Type.Integer({ minimum: 1 }),
    objects: Type.Array(RemoteObjectReceiptSchema, { minItems: 1 }),
    verifiedAt: Type.String({ pattern: UTC_TIMESTAMP_PATTERN }),
  },
  { additionalProperties: false },
);

export function decodeSessionReplicaRecord(text: string, location: string): SessionReplicaRecord {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Replica record ${location} contains invalid JSON: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  if (Value.Check(SessionReplicaRecordSchema, value)) {
    return value as SessionReplicaRecord;
  }
  const first = Value.Errors(SessionReplicaRecordSchema, value)[0];
  const detail = first
    ? `${first.instancePath || "/"}: ${first.message}`
    : "unknown validation error";
  throw new Error(`Invalid session replica record at ${location}: ${detail}`);
}

export function encodeSessionReplicaRecord(record: SessionReplicaRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
