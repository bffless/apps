/**
 * The `cut-editor` island's entry: its stylesheet, then the shared MCP Apps handshake
 * (`islands/lib/mount.tsx`) around `Editor`.
 */
import './styles.css'
import { mountIsland } from '../lib/mount'
import { Editor } from './App'

await mountIsland('cut-editor', (args, bridge) => <Editor args={args} bridge={bridge} />)
