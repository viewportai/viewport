const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');

const SCHEMA_DIR = path.join(__dirname, '..', '..', 'schemas');
const SCHEMA_FILES = [
  'context_key_grant_v1.schema.json',
  'context_key_grant_hpke_draft_01.schema.json',
  'context_event_v1.schema.json',
  'context_bundle_manifest_v1.schema.json',
  'context_profile_v1.schema.json',
  'context_erase_receipt_v1.schema.json',
];

const SCHEMA_IDS = Object.freeze({
  bundleManifest: 'urn:viewport:context_bundle_manifest:v1',
  eraseReceipt: 'urn:viewport:context_erase_receipt:v1',
  event: 'urn:viewport:context_event:v1',
  keyGrant: 'urn:viewport:context_key_grant:v1',
  keyGrantHpkeDraft: 'urn:viewport:context_key_grant:hpke_draft_01',
  profile: 'urn:viewport:context_profile:v1',
});

function loadSchema(name) {
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, name), 'utf8'));
}

function createProtocolValidator() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  for (const schemaName of SCHEMA_FILES) {
    const schema = loadSchema(schemaName);
    ajv.addSchema(schema, schema.$id);
  }

  return {
    ajv,
    validateBundleManifest: ajv.getSchema(SCHEMA_IDS.bundleManifest),
    validateEraseReceipt: ajv.getSchema(SCHEMA_IDS.eraseReceipt),
    validateEvent: ajv.getSchema(SCHEMA_IDS.event),
    validateKeyGrant: ajv.getSchema(SCHEMA_IDS.keyGrant),
    validateKeyGrantHpkeDraft: ajv.getSchema(SCHEMA_IDS.keyGrantHpkeDraft),
    validateProfile: ajv.getSchema(SCHEMA_IDS.profile),
  };
}

module.exports = {
  SCHEMA_IDS,
  createProtocolValidator,
  loadSchema,
};
