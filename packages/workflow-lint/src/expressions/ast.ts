export interface Span {
  start: number
  end: number
}

export type BinOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | '&&' | '||'

export type Expr =
  | { kind: 'null' | 'true' | 'false'; span: Span }
  | { kind: 'number'; value: number; span: Span }
  | { kind: 'string'; value: string; span: Span }
  | { kind: 'ident'; name: string; span: Span }
  | { kind: 'member'; object: Expr; property: string; span: Span }
  | { kind: 'index'; object: Expr; index: Expr; span: Span }
  | { kind: 'call'; callee: string; args: Expr[]; span: Span }
  | { kind: 'not'; operand: Expr; span: Span }
  | { kind: 'binary'; op: BinOp; left: Expr; right: Expr; span: Span }

export class ExprSyntaxError extends Error {
  constructor(
    message: string,
    public offset: number,
  ) {
    super(message)
    this.name = 'ExprSyntaxError'
  }
}
