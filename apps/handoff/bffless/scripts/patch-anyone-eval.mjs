// Replaces the canonical embedded evalAccess body (7 copies) with the
// Anyone-aware body (ADR-0005). Idempotent; exits non-zero on count mismatch.
import { readFileSync, writeFileSync } from 'node:fs'

const P = new URL('../handoff.proxy-rules.json', import.meta.url)
const doc = JSON.parse(readFileSync(P, 'utf8'))

const OLD = `function evalAccess(ch,vw){ if(vw.isAdmin)return 'owner'; if(vw.userId){for(var i=0;i<ch.length;i++){if(ch[i].ownerId===vw.userId)return 'owner';}} if(!vw.userId&&vw.shareLinkFolderId){var inC=false;for(var j=0;j<ch.length;j++){if(ch[j].id===vw.shareLinkFolderId){inC=true;break;}}return inC?'view':'none';} if(!vw.userId)return 'none'; var s=0;for(var k=ch.length-1;k>=0;k--){if(ch[k].mode==='restricted'){s=k;break;}} var best='none';for(var d=s;d<ch.length;d++){var gs=ch[d].grants||[];for(var e=0;e<gs.length;e++){if(gs[e].principalId===vw.userId&&rank(gs[e].level)>rank(best))best=gs[e].level;}} return best; }`

const NEW = `function evalAccess(ch,vw){ if(vw.isAdmin)return 'owner'; if(vw.userId){for(var i=0;i<ch.length;i++){if(ch[i].ownerId===vw.userId)return 'owner';}} var s=0;for(var k=ch.length-1;k>=0;k--){if(ch[k].mode==='restricted'){s=k;break;}} var best='none';for(var d=s;d<ch.length;d++){var gs=ch[d].grants||[];for(var e=0;e<gs.length;e++){var g=gs[e]||{};if(g.principalId==='anyone'){if(rank('view')>rank(best))best='view';}else if(vw.userId&&g.principalId===vw.userId&&rank(g.level)>rank(best))best=g.level;}} if(!vw.userId&&vw.shareLinkFolderId){var inC=false;for(var j=0;j<ch.length;j++){if(ch[j].id===vw.shareLinkFolderId){inC=true;break;}}if(inC&&rank('view')>rank(best))best='view';} return best; }`

let patched = 0
let already = 0
for (const r of doc.rules) {
  for (const s of r.pipelineConfig?.steps ?? []) {
    const c = s.config?.code
    if (!c) continue
    if (c.includes(NEW)) { already++; continue }
    if (c.includes(OLD)) {
      s.config.code = c.split(OLD).join(NEW)
      patched++
    }
  }
}

if (patched + already !== 7) {
  console.error(`expected 7 evalAccess copies, found ${patched + already} (patched ${patched}, already ${already})`)
  process.exit(1)
}
writeFileSync(P, JSON.stringify(doc, null, 2) + '\n')
console.log(`patched ${patched} evalAccess copies (${already} already current)`)
