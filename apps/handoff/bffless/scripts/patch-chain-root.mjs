#!/usr/bin/env node
/**
 * Inject the singleton root record R into Handoff's ACL chain-building gates.
 *
 * Every gate authorizes access by building a folder chain via an embedded
 * `folderChain` that walks `parentId` upward, but the walk stops at the 'root'
 * sentinel — so R (created in Task 4) is never in the chain and a root-scoped
 * share visitor / root grantee is never matched. This patch makes each
 * `folderChain`:
 *   1. capture R's id while building `byId`  (f.nodeType==='root' -> rootId), and
 *   2. resolve parentId==='root' -> rootId   (so R becomes chain[0]);
 * and widens each chain-feeding query (`allFolders` / `folders`) from
 * nodeType eq 'folder' to in ['folder','root'] so R is actually fetched.
 *
 * TWO folderChain variants exist and BOTH are handled:
 *   Variant A (7 copies) — `function folderChain(folders,startId)`; builds `byId`
 *     INSIDE with loop var `id` (builder ends `if(id)byId[id]=f;}`).
 *   Variant B (1 copy, GET /api/nodes:shape) — `function folderChain(startId)`;
 *     `byId` is built OUTSIDE the function with loop var `fid`
 *     (builder ends `if(fid)byId[fid]=f;}`) and closed over.
 *
 * The shape step ALSO carries a `folderPath` breadcrumb walk. It must NOT gain
 * root (prepending "My Files" would corrupt every displayed path). folderPath's
 * walk line is `cur=byId[cur].parentId||'';`, distinct from folderChain's
 * `cur=n.parentId||'';`, so the string replace below cannot touch it.
 *
 * The `resolve/*:gate` step (Variant A) carries its own folderPath too, giving
 * it a SECOND `var byId={};`; folderChain's builder is earlier in the code and
 * ends with the distinct `if(id)...` (vs the outer `if(id0)...`), so the
 * first-occurrence string replaces land in folderChain only.
 *
 * Idempotent: a folderChain already carrying `var rootId=` is skipped; filters
 * already `in [folder,root]` are left as-is.
 *
 * Writes back with `JSON.stringify(doc, null, 2) + '\n'` (the file's canonical
 * form) so the diff stays localized. Run from the app dir:
 *   node bffless/scripts/patch-chain-root.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'

const jsonUrl = new URL('../handoff.proxy-rules.json', import.meta.url)
const doc = JSON.parse(readFileSync(jsonUrl, 'utf8'))

const SENTINEL = "cur=(n.parentId==='root'&&rootId)?rootId:(n.parentId||'');"

let chains = 0
let filters = 0

for (const rule of doc.rules) {
  const steps = (rule.pipelineConfig && rule.pipelineConfig.steps) || []
  for (const s of steps) {
    // --- Widen chain-feeding queries -------------------------------------
    const nt = s.config && s.config.filters && s.config.filters.nodeType
    if (
      (s.id === 'allFolders' || s.id === 'folders') &&
      nt &&
      nt.op === 'eq' &&
      nt.value === 'folder'
    ) {
      s.config.filters.nodeType = { op: 'in', value: ['folder', 'root'] }
      filters++
    }

    // --- Inject root into folderChain ------------------------------------
    const code = s.config && s.config.code
    if (typeof code !== 'string' || !code.includes('function folderChain')) continue
    if (code.includes('var rootId=')) continue // already patched (idempotent)

    let next
    if (code.includes('function folderChain(folders,startId)')) {
      // Variant A: byId built inside with loop var `id`.
      if (
        !code.includes('var byId={};') ||
        !code.includes('if(id)byId[id]=f;}') ||
        !code.includes("cur=n.parentId||'';")
      ) {
        throw new Error(`Variant A substrings missing in ${rule.method} ${rule.pathPattern}:${s.id}`)
      }
      next = code
        .replace('var byId={};', "var byId={};var rootId='';")
        .replace('if(id)byId[id]=f;}', "if(id){byId[id]=f;if(f.nodeType==='root')rootId=id;}}")
        .replace("cur=n.parentId||'';", SENTINEL)
    } else if (code.includes('function folderChain(startId)')) {
      // Variant B: byId built outside with loop var `fid`.
      if (
        !code.includes('var byId={};') ||
        !code.includes('if(fid)byId[fid]=f;}') ||
        !code.includes("cur=n.parentId||'';")
      ) {
        throw new Error(`Variant B substrings missing in ${rule.method} ${rule.pathPattern}:${s.id}`)
      }
      next = code
        .replace('var byId={};', "var byId={};var rootId='';")
        .replace('if(fid)byId[fid]=f;}', "if(fid){byId[fid]=f;if(f.nodeType==='root')rootId=fid;}}")
        .replace("cur=n.parentId||'';", SENTINEL)
    } else {
      throw new Error(`Unknown folderChain variant in ${rule.method} ${rule.pathPattern}:${s.id}`)
    }

    if (next === code) throw new Error(`no-op patch in ${rule.method} ${rule.pathPattern}:${s.id}`)
    s.config.code = next
    chains++
  }
}

writeFileSync(jsonUrl, JSON.stringify(doc, null, 2) + '\n')
console.log(`chains patched: ${chains} filters: ${filters}`)
