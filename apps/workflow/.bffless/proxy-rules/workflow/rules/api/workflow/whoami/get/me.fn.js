// The calling member's identity, as an object the responder serializes.
//
// This used to be a JSON body hand-built in a template
// (`'{"id":"{{user.id}}","email":"{{user.email}}",…}'`). That is only correct while
// every value happens to be quote-free: an email or a role carrying a `"` or a `\`
// would have produced a malformed body and a parse error on the client, and the
// escaping is not something a template can do for you. Returning an object and
// rendering it with `{{{steps.me}}}` hands the serialization to CE (the same shape the
// files/register rule uses), so the body is well-formed whatever the field values are.
//
// CE hands a function_handler `user` as { id, email, role, projectRole, groups }, or
// `undefined` for a caller it could not resolve to a person — an API key with no user
// (function.handler.ts). The four fields stay ALWAYS PRESENT and always strings: the
// previous template rendered a null as an empty string, readers were told to tolerate that
// (spec 05, the run header only offers Delete when it can prove ownership), and dropping
// keys instead would be a breaking change to that contract.
//
// `projectRole` is the role on THIS project (owner | admin | contributor | viewer),
// resolved from `project_permissions` — not the instance-wide `role` (spec 11 §Why
// `projectRole`). It is the one thing the SPA cannot work out for itself: whether to offer
// the "All runs" toggle at all (D27). Empty for a caller CE has no permission row for, and
// on a CE older than the release that added it — both of which read as "no toggle", which
// is why it is reported the same way as the other three rather than omitted.
function handler({ user }) {
  const caller = user || {}
  const str = (value) => (typeof value === 'string' ? value : value == null ? '' : String(value))
  return {
    id: str(caller.id),
    email: str(caller.email),
    role: str(caller.role),
    projectRole: str(caller.projectRole),
  }
}
