import { Type } from "typebox";

const Sha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });

export const ObjectReferenceProperties = {
  algorithm: Type.Literal("sha256"),
  digest: Sha256Schema,
  encoding: Type.Literal("gzip"),
  logicalBytes: Type.Integer({ minimum: 0 }),
  storedBytes: Type.Integer({ minimum: 0 }),
};

export const ObjectReferenceSchema = Type.Object(ObjectReferenceProperties, {
  additionalProperties: false,
});
