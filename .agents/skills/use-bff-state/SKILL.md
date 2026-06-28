---
name: use-bff-state
description: React hook for managing server-side state with BFFless Data Tables and Pipelines, with guest IDs, loading states, and stale refetching
---

# @bffless/use-bff-state

React hook library for managing server-side state with BFFless Data Tables and Pipelines. Enables React apps to synchronize state with a BFFless backend, with automatic guest identification, loading states, error handling, and stale data refetching.

- **NPM Package**: `@bffless/use-bff-state`
- **Docs**: https://docs.bffless.app/recipes/state-management/
- **Peer Dependency**: React 18 or 19

## Installation

```bash
npm install @bffless/use-bff-state
```

## Setup

Wrap your app with `BffStateProvider`:

```tsx
import { BffStateProvider } from '@bffless/use-bff-state';

<BffStateProvider
  options={{
    baseUrl: '/api', // URL prefix for all requests
    headers: {}, // Global headers for all requests
    persistence: 'forever', // Guest ID cookie: 'session' | { days: N } | 'forever'
    staleTime: 5000, // ms before refetch on window focus
  }}
>
  <App />
</BffStateProvider>;
```

All options are optional. The provider can be used with no options: `<BffStateProvider><App /></BffStateProvider>`.

## Core Hook: `useBffState`

```tsx
import { useBffState } from '@bffless/use-bff-state';

const {
  data,             // T — current state (initialValue until first fetch)
  guestId,          // string — UUID for this browser/session
  loading,          // boolean — isFetching OR isUpdating
  error,            // Error | null
  update,           // (newState: T | (prev: T) => T) => Promise<void>
  refetch,          // () => Promise<void>
  isUninitialized,  // true before first fetch
  isFetching,       // true during GET
  isUpdating,       // true during POST
} = useBffState<T>(path, initialValue, options?);
```

### Hook Options

| Option                 | Type                     | Default | Description                              |
| ---------------------- | ------------------------ | ------- | ---------------------------------------- |
| `skip`                 | `boolean`                | `false` | Skip initial fetch (conditional loading) |
| `headers`              | `Record<string, string>` | `{}`    | Per-hook headers (merged with provider)  |
| `refetchOnWindowFocus` | `boolean`                | `true`  | Refetch when tab visible if data stale   |

## Usage Patterns

### Basic State

```tsx
const { data, update } = useBffState('/api/preferences', { theme: 'light' });

// Direct update
await update({ theme: 'dark' });

// Functional update (uses current state)
await update((prev) => ({ ...prev, theme: 'dark' }));
```

### Shopping Cart

```tsx
const {
  data: cart,
  update,
  loading,
} = useBffState('/api/cart', {
  items: [],
  total: 0,
});

const addItem = async (item) => {
  await update((prev) => ({
    items: [...prev.items, item],
    total: prev.total + item.price,
  }));
};
```

### Conditional Fetching

```tsx
const { data } = useBffState(
  `/api/users/${userId}/prefs`,
  { theme: 'light' },
  { skip: !userId }, // Don't fetch until userId exists
);
```

### Feature Flags

```tsx
const { data: flags, update } = useBffState('/api/feature-flags', {
  darkMode: false,
  betaFeatures: false,
});
```

## Other Exports

```tsx
import { useGuestId, useBffStateContext } from '@bffless/use-bff-state';

const guestId = useGuestId(); // Get current guest ID
const context = useBffStateContext(); // Access provider config
```

### Core Utilities (Advanced)

```tsx
import {
  generateUuid,
  readGuestId,
  writeGuestId,
  getOrCreateGuestId,
  fetchState,
  updateState,
  appendGuestIdParam,
  buildUrl,
  mergeHeaders,
} from '@bffless/use-bff-state';
```

## How It Works

- **Guest ID**: UUID v4 stored in `bff-guest-id` cookie. Lazy-created on first use. Appended to all requests as `?_bffGuestId=<uuid>`.
- **Fetching**: GET request on mount (unless `skip: true`). Response JSON becomes `data`.
- **Updating**: POST request with new state as JSON body. Response becomes new `data`.
- **Stale Refetch**: On window focus, refetches if `Date.now() - lastFetch > staleTime`.
- **Abort**: Requests aborted on unmount or when new fetch starts. AbortError silently ignored.
- **Credentials**: All requests use `credentials: 'include'` for cookie handling.

## Backend API Contract

The hook expects these endpoints:

**GET `{path}?_bffGuestId=<uuid>`** — Returns JSON state object
**POST `{path}?_bffGuestId=<uuid>`** — Body: JSON state. Returns confirmed/updated state.

These map to BFFless Pipeline proxy rules with `state-get` and `state-set` handler types.

## Type Safety

Generic type inferred from initial value or explicit:

```tsx
interface CartState {
  items: CartItem[];
  total: number;
}
const { data, update } = useBffState<CartState>('/api/cart', { items: [], total: 0 });
// data is CartState, update expects CartState | (prev: CartState) => CartState
```