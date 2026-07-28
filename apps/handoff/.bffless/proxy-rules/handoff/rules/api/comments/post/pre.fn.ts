import type { HandlerContext } from 'bffless/handlers';

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MAX_BODY = 5000;

interface Body { nodeId?: unknown; body?: unknown; parentId?: unknown; anchor?: unknown }

/** Validate an anchor object; returns its JSON string or '' when absent/invalid. */
function anchorString(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '';
  const o = raw as Record<string, unknown>;
  if (o.type === 'text') {
    const start = Number(o.start), end = Number(o.end);
    if (!isFinite(start) || !isFinite(end) || start < 0 || end < start) return '';
    return JSON.stringify({
      type: 'text',
      quote: String(o.quote || '').slice(0, 1000),
      prefix: String(o.prefix || '').slice(0, 64),
      suffix: String(o.suffix || '').slice(0, 64),
      start: start, end: end,
    });
  }
  if (o.type === 'pin') {
    const x = Number(o.x), y = Number(o.y);
    if (!isFinite(x) || !isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return '';
    return JSON.stringify({ type: 'pin', x: x, y: y });
  }
  return '';
}

export default function handler({ request }: HandlerContext) {
  const b: Body = ((request && request.body) as Body) || {};
  const nodeId = String(b.nodeId || '');
  const parentId = b.parentId == null ? '' : String(b.parentId);
  const bodyText = typeof b.body === 'string' ? b.body : '';
  const trimmed = bodyText.replace(/^\s+|\s+$/g, '');

  const nodeOk = !!nodeId && UUID.test(nodeId);
  const parentOk = parentId === '' || UUID.test(parentId);
  const bodyOk = trimmed.length > 0 && trimmed.length <= MAX_BODY;
  const isReply = parentOk && parentId !== '';

  return {
    ok: nodeOk && parentOk && bodyOk,
    isReply: isReply,
    bodyValue: trimmed,
    parentIdValue: isReply ? parentId : '',
    anchorValue: isReply ? '' : anchorString(b.anchor),
  };
}
