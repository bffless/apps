/** The dev worker; started from `main.tsx` when the master switch is on. */
import { setupWorker } from 'msw/browser'
import { handlers } from './handlers'

export const worker = setupWorker(...handlers)
