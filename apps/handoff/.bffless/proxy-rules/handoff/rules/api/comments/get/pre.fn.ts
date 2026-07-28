import type { HandlerContext } from 'bffless/handlers';

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export default function handler({ request }: HandlerContext) {
  const q = (request && request.query) || ({} as Record<string, unknown>);
  const nodeId = String((q as { nodeId?: unknown }).nodeId || '');
  return { nodeId: nodeId, idOk: !!nodeId && UUID.test(nodeId) };
}
