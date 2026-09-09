import { NavLink } from 'react-router-dom'
import { LastRunPill } from './LastRunPill'
import { workflowId } from '../lib/coerce'
import { useDiscoverQuery } from '../store/workflowApi'

function Rail() {
  const { data: implementations, isLoading, isError } = useDiscoverQuery()

  if (isLoading) return <p className="rail-note">Loading…</p>
  // Distinct from "nothing published": a failed alias list says nothing about
  // what this project has (08). The pages carry the detail; the rail is 15rem.
  if (isError) return <p className="rail-note">Couldn't reach the server</p>
  if (!implementations?.length) return <p className="rail-note">No implementations</p>

  return (
    <ul className="rail-tree">
      {implementations.map((impl) => (
        <li key={impl.alias}>
          {impl.error ? (
            <span className="rail-impl is-error">{impl.name}</span>
          ) : (
            <NavLink className="rail-impl" to={`/${impl.alias}`} end>
              {impl.name}
            </NavLink>
          )}
          {impl.workflows.length > 0 && (
            <ul className="rail-workflows">
              {impl.workflows.map((listing) => (
                <li key={listing.file}>
                  <NavLink className="rail-workflow" to={`/${impl.alias}/${workflowId(listing.file)}`}>
                    <LastRunPill impl={impl.alias} workflow={workflowId(listing.file)} glyphOnly />
                    <span className="rail-workflow-name">{listing.name}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  )
}

export function ImplementationRail() {
  return (
    <nav className="rail" aria-label="Implementations">
      <p className="rail-eyebrow">Implementations</p>
      <Rail />
    </nav>
  )
}
