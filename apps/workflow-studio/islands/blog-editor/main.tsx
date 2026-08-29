/**
 * The `blog-editor` island's entry: its stylesheet, then the shared MCP Apps handshake
 * (`islands/lib/mount.tsx`) around `Review`.
 */
import './styles.css'
import { mountIsland } from '../lib/mount'
import { Review } from './App'

await mountIsland('blog-editor', (args, bridge) => <Review args={args} bridge={bridge} />)
