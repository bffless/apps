/**
 * Shared icon set for Handoff — consistent 20×20 viewBox, `currentColor`, sized
 * by the caller via `className` (default h-5 w-5). One source of truth so the
 * listing, menus, viewer, and dialogs use the same visual vocabulary.
 */

import type { SVGProps } from 'react'
import type { NodeType } from '../lib/nodes'
import { leafKind } from '../lib/fileKind'

type IconProps = SVGProps<SVGSVGElement>

function Svg({ className, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
      className={className ?? 'h-5 w-5'}
      {...rest}
    >
      {children}
    </svg>
  )
}

export const SunIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 2a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 10 2ZM10 15.5a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5a.75.75 0 0 1 .75-.75ZM18 10a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 18 10ZM4.25 10a.75.75 0 0 1-.75.75H2a.75.75 0 0 1 0-1.5h1.5a.75.75 0 0 1 .75.75ZM15.66 4.34a.75.75 0 0 1 0 1.06l-1.06 1.06a.75.75 0 1 1-1.06-1.06l1.06-1.06a.75.75 0 0 1 1.06 0ZM6.46 13.54a.75.75 0 0 1 0 1.06l-1.06 1.06a.75.75 0 0 1-1.06-1.06l1.06-1.06a.75.75 0 0 1 1.06 0ZM15.66 15.66a.75.75 0 0 1-1.06 0l-1.06-1.06a.75.75 0 1 1 1.06-1.06l1.06 1.06a.75.75 0 0 1 0 1.06ZM6.46 6.46a.75.75 0 0 1-1.06 0L4.34 5.4a.75.75 0 0 1 1.06-1.06l1.06 1.06a.75.75 0 0 1 0 1.06Z" />
    <path d="M10 6a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" />
  </Svg>
)

export const MoonIcon = (p: IconProps) => (
  <Svg {...p}>
    <path
      fillRule="evenodd"
      d="M7.455 2.004a.75.75 0 0 1 .26.77 7 7 0 0 0 9.958 7.967.75.75 0 0 1 1.067.853A8.5 8.5 0 1 1 6.647 1.921a.75.75 0 0 1 .808.083Z"
      clipRule="evenodd"
    />
  </Svg>
)

export const ChevronDownIcon = (p: IconProps) => (
  <Svg {...p}>
    <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
  </Svg>
)

export const ChevronUpIcon = (p: IconProps) => (
  <Svg {...p}>
    <path fillRule="evenodd" d="M14.78 11.78a.75.75 0 0 1-1.06 0L10 8.06l-3.72 3.72a.75.75 0 1 1-1.06-1.06l4.25-4.25a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06Z" clipRule="evenodd" />
  </Svg>
)

export const ChevronRightIcon = (p: IconProps) => (
  <Svg {...p}>
    <path fillRule="evenodd" d="M8.22 5.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
  </Svg>
)

export const PlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 3a.75.75 0 0 1 .75.75v5.5h5.5a.75.75 0 0 1 0 1.5h-5.5v5.5a.75.75 0 0 1-1.5 0v-5.5h-5.5a.75.75 0 0 1 0-1.5h5.5v-5.5A.75.75 0 0 1 10 3Z" />
  </Svg>
)

export const UploadIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.25 13.25V5.66L6.3 8.78a.75.75 0 1 1-1.1-1.02l4.25-4.5a.75.75 0 0 1 1.1 0l4.25 4.5a.75.75 0 1 1-1.1 1.02l-2.95-3.12v7.59a.75.75 0 0 1-1.5 0Z" />
    <path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z" />
  </Svg>
)

export const FolderPlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.75 3A1.75 1.75 0 0 0 2 4.75v3.26A3.2 3.2 0 0 1 3.75 7.5h12.5c.65 0 1.25.19 1.75.51V6.75A1.75 1.75 0 0 0 16.25 5h-4.84a.25.25 0 0 1-.17-.07L9.82 3.51A1.75 1.75 0 0 0 8.59 3H3.75ZM2 10.75v4.5C2 16.22 2.78 17 3.75 17h12.5A1.75 1.75 0 0 0 18 15.25v-4.5A1.75 1.75 0 0 0 16.25 9H3.75A1.75 1.75 0 0 0 2 10.75ZM10.75 11a.75.75 0 0 0-1.5 0v1.25H8a.75.75 0 0 0 0 1.5h1.25V15a.75.75 0 0 0 1.5 0v-1.25H12a.75.75 0 0 0 0-1.5h-1.25V11Z" />
  </Svg>
)

export const ArchiveIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 3.75A.75.75 0 0 1 2.75 3h14.5a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-.75.75H2.75A.75.75 0 0 1 2 5.25v-1.5Z" />
    <path fillRule="evenodd" d="M3 7.5h14v7.75A1.75 1.75 0 0 1 15.25 17h-3.5v-2.5a1.75 1.75 0 0 0-3.5 0V17h-3.5A1.75 1.75 0 0 1 3 15.25V7.5Zm6.25 1.75a.75.75 0 0 0 0 1.5h1.5a.75.75 0 0 0 0-1.5h-1.5Z" clipRule="evenodd" />
  </Svg>
)

export const KebabIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 6a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM10 11.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM11.5 15.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z" />
  </Svg>
)

export const ShareIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13 4.5a2.5 2.5 0 1 1 .7 1.74L6.97 9.6a2.52 2.52 0 0 1 0 .8l6.73 3.36a2.5 2.5 0 1 1-.67 1.34L6.3 11.74a2.5 2.5 0 1 1 0-3.48l6.73-3.36A2.5 2.5 0 0 1 13 4.5Z" />
  </Svg>
)

export const LinkIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8.5 5.5a3.5 3.5 0 0 1 5.78-2.66l.38.38a3.5 3.5 0 0 1-.18 5.12l-1.2 1.06a.75.75 0 1 1-1-1.12l1.2-1.06a2 2 0 0 0 .1-2.93l-.38-.38A2 2 0 0 0 10 5.5a.75.75 0 0 1-1.5 0Z" />
    <path d="M11.5 14.5a3.5 3.5 0 0 1-5.78 2.66l-.38-.38a3.5 3.5 0 0 1 .18-5.12l1.2-1.06a.75.75 0 1 1 1 1.12l-1.2 1.06a2 2 0 0 0-.1 2.93l.38.38A2 2 0 0 0 10 14.5a.75.75 0 0 1 1.5 0Z" />
    <path d="M7.6 12.4a.75.75 0 0 0 1.06 1.06l4-4A.75.75 0 0 0 11.6 8.4l-4 4Z" />
  </Svg>
)

export const TrashIcon = (p: IconProps) => (
  <Svg {...p}>
    <path fillRule="evenodd" d="M8.75 1a1 1 0 0 0-.95.68L7.44 3H4.25a.75.75 0 0 0 0 1.5h.46l.66 11.07A2 2 0 0 0 7.42 17.5h5.16a2 2 0 0 0 2-1.93L15.29 4.5h.46a.75.75 0 0 0 0-1.5h-3.19l-.36-1.32A1 1 0 0 0 11.25 1h-2.5ZM8.5 7.25a.75.75 0 0 1 1.5 0v5.5a.75.75 0 0 1-1.5 0v-5.5Zm3.25-.75a.75.75 0 0 0-.75.75v5.5a.75.75 0 0 0 1.5 0v-5.5a.75.75 0 0 0-.75-.75Z" clipRule="evenodd" />
  </Svg>
)

export const PencilIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m13.5 3.94 2.56 2.56-7.5 7.5-2.84.28.28-2.84 7.5-7.5ZM14.56 2.88a1.5 1.5 0 0 1 2.12 0l.44.44a1.5 1.5 0 0 1 0 2.12l-.62.62-2.56-2.56.62-.62ZM4 16.5a.75.75 0 0 0 0 1.5h12a.75.75 0 0 0 0-1.5H4Z" />
  </Svg>
)

export const MoveIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 2.75a.75.75 0 0 1 .53.22l2 2a.75.75 0 1 1-1.06 1.06l-.72-.72v3.94h3.94l-.72-.72a.75.75 0 1 1 1.06-1.06l2 2a.75.75 0 0 1 0 1.06l-2 2a.75.75 0 1 1-1.06-1.06l.72-.72h-3.94v3.94l.72-.72a.75.75 0 1 1 1.06 1.06l-2 2a.75.75 0 0 1-1.06 0l-2-2a.75.75 0 1 1 1.06-1.06l.72.72v-3.94H5.31l.72.72a.75.75 0 0 1-1.06 1.06l-2-2a.75.75 0 0 1 0-1.06l2-2a.75.75 0 0 1 1.06 1.06l-.72.72h3.94V5.31l-.72.72a.75.75 0 0 1-1.06-1.06l2-2A.75.75 0 0 1 10 2.75Z" />
  </Svg>
)

export const SearchIcon = (p: IconProps) => (
  <Svg {...p}>
    <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 3.42 9.8l3.14 3.14a.75.75 0 1 0 1.06-1.06l-3.14-3.14A5.5 5.5 0 0 0 9 3.5ZM5 9a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z" clipRule="evenodd" />
  </Svg>
)

export const ExternalIcon = (p: IconProps) => (
  <Svg {...p}>
    <path fillRule="evenodd" d="M4.25 5.5a.75.75 0 0 0-.75.75v8.5c0 .41.34.75.75.75h8.5a.75.75 0 0 0 .75-.75v-4a.75.75 0 0 1 1.5 0v4A2.25 2.25 0 0 1 12.75 17h-8.5A2.25 2.25 0 0 1 2 14.75v-8.5A2.25 2.25 0 0 1 4.25 4h5a.75.75 0 0 1 0 1.5h-5Z" clipRule="evenodd" />
    <path fillRule="evenodd" d="M6.19 12.75a.75.75 0 0 0 1.06.06L16.5 4.44v2.81a.75.75 0 0 0 1.5 0v-4.5a.75.75 0 0 0-.75-.75h-4.5a.75.75 0 0 0 0 1.5h2.55l-9.05 8.19a.75.75 0 0 0-.06 1.06Z" clipRule="evenodd" />
  </Svg>
)

export const CheckIcon = (p: IconProps) => (
  <Svg {...p}>
    <path fillRule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0l-3.5-3.5a1 1 0 1 1 1.4-1.4l2.8 2.79 6.8-6.79a1 1 0 0 1 1.4 0Z" clipRule="evenodd" />
  </Svg>
)

export const XIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
  </Svg>
)

// --- file-type icons --------------------------------------------------------

export const FolderIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.75 3A1.75 1.75 0 0 0 2 4.75v3.26A3.2 3.2 0 0 1 3.75 7.5h12.5c.65 0 1.25.19 1.75.51V6.75A1.75 1.75 0 0 0 16.25 5h-4.84a.25.25 0 0 1-.17-.07L9.82 3.51A1.75 1.75 0 0 0 8.59 3H3.75ZM3.75 9A1.75 1.75 0 0 0 2 10.75v4.5c0 .97.78 1.75 1.75 1.75h12.5A1.75 1.75 0 0 0 18 15.25v-4.5A1.75 1.75 0 0 0 16.25 9H3.75Z" />
  </Svg>
)

/** Site — a browser window glyph (rendered, live content). */
export const SiteIcon = (p: IconProps) => (
  <Svg {...p}>
    <path fillRule="evenodd" d="M3.5 3A1.5 1.5 0 0 0 2 4.5v11A1.5 1.5 0 0 0 3.5 17h13a1.5 1.5 0 0 0 1.5-1.5v-11A1.5 1.5 0 0 0 16.5 3h-13Zm0 1.5h13v2h-13v-2Zm.75 1.25a.6.6 0 1 0 0-1.2.6.6 0 0 0 0 1.2Zm2 0a.6.6 0 1 0 0-1.2.6.6 0 0 0 0 1.2Z" clipRule="evenodd" />
  </Svg>
)

function FileBase({ accent, className }: { accent?: React.ReactNode; className?: string }) {
  return (
    <Svg className={className}>
      <path d="M4.5 2A1.5 1.5 0 0 0 3 3.5v13A1.5 1.5 0 0 0 4.5 18h11a1.5 1.5 0 0 0 1.5-1.5V7.62a1.5 1.5 0 0 0-.44-1.06l-4.12-4.12A1.5 1.5 0 0 0 11.38 2H4.5Z" opacity="0.35" />
      {accent}
    </Svg>
  )
}

export const PdfIcon = (p: IconProps) => (
  <FileBase className={p.className} accent={<path d="M6.2 10.5h7.6a.6.6 0 0 1 0 1.2H6.2a.6.6 0 0 1 0-1.2Zm0 2.6h7.6a.6.6 0 0 1 0 1.2H6.2a.6.6 0 0 1 0-1.2Zm0-5.2h3.2a.6.6 0 0 1 0 1.2H6.2a.6.6 0 0 1 0-1.2Z" />} />
)

export const ImageIcon = (p: IconProps) => (
  <FileBase className={p.className} accent={<path fillRule="evenodd" d="M6.4 9a1.1 1.1 0 1 1 0-2.2 1.1 1.1 0 0 1 0 2.2Zm-1.4 5.5 2.7-3 2 2.2 2.3-2.6 3 3.4H5Z" clipRule="evenodd" />} />
)

export const VideoIcon = (p: IconProps) => (
  <FileBase className={p.className} accent={<path d="M8 8.2v5.6a.5.5 0 0 0 .77.42l4.3-2.8a.5.5 0 0 0 0-.84l-4.3-2.8A.5.5 0 0 0 8 8.2Z" />} />
)

export const AudioIcon = (p: IconProps) => (
  <FileBase className={p.className} accent={<path d="M13 7.5a.6.6 0 0 0-.75-.58l-4 1.1a.6.6 0 0 0-.45.58v3.5a1.8 1.8 0 1 0 1.2 1.7V9.55l2.8-.77v2.02a1.8 1.8 0 1 0 1.2 1.7V7.5Z" />} />
)

export const MarkdownIcon = (p: IconProps) => (
  <FileBase className={p.className} accent={<path d="M5.5 13.5v-4a.5.5 0 0 1 .87-.33L7.8 10.6l1.43-1.43a.5.5 0 0 1 .87.33v4a.6.6 0 0 1-1.2 0v-2.36l-.83.83a.5.5 0 0 1-.7 0l-.85-.85v2.38a.6.6 0 0 1-1.2 0Zm7.2.4a.5.5 0 0 1-.74 0l-1.5-1.7a.5.5 0 0 1 .74-.66l.43.48V9.4a.6.6 0 0 1 1.2 0v2.62l.43-.48a.5.5 0 1 1 .74.66l-1.5 1.7Z" />} />
)

export const FileIcon = (p: IconProps) => <FileBase className={p.className} />

// --- mapping ----------------------------------------------------------------

/**
 * Icon for any node by type — renders the glyph directly (no dynamic component
 * variable, so it satisfies react-hooks/static-components).
 */
export function NodeIcon({
  type,
  name,
  mime,
  className,
}: {
  type: NodeType
  name: string
  mime: string | null
  className?: string
}) {
  if (type === 'folder') return <FolderIcon className={className} />
  if (type === 'site') return <SiteIcon className={className} />
  switch (leafKind(name, mime)) {
    case 'image':
      return <ImageIcon className={className} />
    case 'video':
      return <VideoIcon className={className} />
    case 'audio':
      return <AudioIcon className={className} />
    case 'pdf':
      return <PdfIcon className={className} />
    case 'markdown':
      return <MarkdownIcon className={className} />
    default:
      return <FileIcon className={className} />
  }
}
