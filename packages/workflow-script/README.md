# @bffless/workflow-script

Types for the BFFless Workflow harness's `script` step module contract
(spec `apps/workflow/docs/spec/03-step-kinds.md`). Zero runtime — this
package ships only `index.d.ts`.

A `script` step is an ES module the harness's Worker imports and calls with
one `ctx: ScriptContext`; the module's default export returns the step's
outputs. Type a script either with a JSDoc annotation (plain `.js`, no build
step):

```js
/** @type {import('@bffless/workflow-script').ScriptModule['default']} */
export default async function run(ctx) {
  ctx.log('starting')
  return { line: ctx.inputs.greeting }
}
```

...or, if an implementation's scripts are authored in TypeScript and built
before publishing:

```ts
import type { ScriptModule } from '@bffless/workflow-script'

const run: ScriptModule['default'] = async (ctx) => {
  ctx.log('starting')
  return { line: ctx.inputs.greeting }
}

export default run
```

See `index.d.ts` for the full `FileRef`/`ScriptContext`/`ScriptModule`
contract.
