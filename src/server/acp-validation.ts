import { createRequire } from "node:module";
import { Ajv2020 } from "ajv/dist/2020.js";
const schema = createRequire(import.meta.url)(
  "@agentclientprotocol/sdk/schema/v1/schema.json",
);
const ajv = new Ajv2020({ strict: false, validateFormats: false });
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
export function validateAcp(
  name:
    "RequestPermissionRequest" | "SessionNotification" | "InitializeResponse",
  value: unknown,
) {
  let validate = validators.get(name);
  if (!validate) {
    validate = ajv.compile({ $defs: schema.$defs, $ref: "#/$defs/" + name });
    validators.set(name, validate);
  }
  return validate(value) === true;
}
