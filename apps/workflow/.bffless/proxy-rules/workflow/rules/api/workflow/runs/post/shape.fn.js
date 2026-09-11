// Strip `driveKey` (spec 11 D28) from the created run before it rides the
// response: the driver's nonce must never leave the harness in a body — it
// travels only in `client_payload.drive_key` and the `x-workflow-drive-key`
// request header. `data_create` answers the created record directly (CE's
// data-create.handler.ts); the `fields` envelope is kept in case an older CE
// nests columns under it — the same tolerance `run/get`'s `shape.fn.js` keeps.
function handler({ steps }) {
  const created = steps.create
  if (!created || typeof created !== 'object') return created
  const nested = created.fields && typeof created.fields === 'object' && Object.keys(created.fields).length > 0
  if (nested) {
    if (!('driveKey' in created.fields)) return created
    const fields = Object.assign({}, created.fields)
    delete fields.driveKey
    return Object.assign({}, created, { fields })
  }
  if (!('driveKey' in created)) return created
  const copy = Object.assign({}, created)
  delete copy.driveKey
  return copy
}
