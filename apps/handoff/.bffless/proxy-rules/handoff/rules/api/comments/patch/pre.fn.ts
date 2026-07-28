import type { HandlerContext } from 'bffless/handlers';

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MAX_BODY = 5000;
const MAX_EMOJI = 16;

const OPS = ['edit', 'resolve', 'reopen', 'react'] as const;
type Op = (typeof OPS)[number];

interface Body { id?: unknown; op?: unknown; body?: unknown; emoji?: unknown }

export default function handler({ request }: HandlerContext) {
  const b: Body = ((request && request.body) as Body) || {};
  const id = String(b.id || '');
  const opRaw = String(b.op || '');
  const op = opRaw as Op;

  const idOk = !!id && UUID.test(id);
  const opOk = (OPS as readonly string[]).includes(opRaw);

  const bodyRaw = typeof b.body === 'string' ? b.body : '';
  const newBody = bodyRaw.replace(/^\s+|\s+$/g, '');
  const bodyOk = newBody.length > 0 && newBody.length <= MAX_BODY;

  const emoji = typeof b.emoji === 'string' ? b.emoji : '';
  const emojiOk = emoji.length > 0 && emoji.length <= MAX_EMOJI;

  return {
    idOk: idOk,
    op: op,
    opOk: opOk,
    newBody: newBody,
    bodyOk: bodyOk,
    emoji: emoji,
    emojiOk: emojiOk,
  };
}
