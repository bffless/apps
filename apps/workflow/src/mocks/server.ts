/** The node-side mock backend: every test runs against it (see `src/test/setup.ts`). */
import { setupServer } from 'msw/node'
import { handlers } from './handlers'

export const server = setupServer(...handlers)
