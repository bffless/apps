// apps#467: a postStep that THROWS writes nothing to `steps`, and CE's runPostSteps logs
// the failure and carries on to the next step - so with `check` thrown, neither finishOk
// nor finishErr fires and the job row would sit `running` until the workflow's poll
// timeout. This is the ONLY ungated postStep: `steps.prep.ok` is folded in HERE because a
// step `condition` is a simple path (no `!`, no `&&`), and because after the `refuse`
// branch has answered 400 there is no job row for finishStuck to write onto. `check` is
// itself gated on `steps.prep.ok` only, so with prep ok its output is absent exactly when
// it threw.
function handler({ steps, stepErrors }) {
  var prep = (steps && steps.prep) || {}
  var out = steps && steps.check
  var stuck = prep.ok === true && (out === undefined || out === null)
  if (!stuck) return { stuck: false, message: '' }
  // ce#662 forward-compat, as in the check.fn.js steps: carry the thrown step's CE code +
  // message when the context has them. On today's CE `stepErrors` is undefined.
  var err = stepErrors && stepErrors.check
  var detail = (err && (err.code || err.message)) ? ' (' + [err.code, err.message].filter(Boolean).join(': ') + ')' : ''
  return { stuck: true, message: "Job step 'check' threw and wrote no output" + detail }
}
