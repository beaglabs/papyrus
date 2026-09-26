import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildApp, manifest } from '../src/agent/apps/project.js'
const files={
 'papyrus.app.json':JSON.stringify({formatVersion:1,title:'Test',entry:'src/main.tsx',auth:'inherit-entra',preset:'react'}),
 'package.json':JSON.stringify({dependencies:{react:'19.2.3','react-dom':'19.2.3'}}),
 'src/main.tsx':"import React from 'react'; import {createRoot} from 'react-dom/client'; createRoot(document.getElementById('root')!).render(<h1>Test app</h1>);",
}
describe('app build boundary',()=>{
 it('rejects anonymous auth and escaping entries',()=>{
   expect(()=>manifest({...files,'papyrus.app.json':JSON.stringify({formatVersion:1,entry:'../private',auth:'anonymous',preset:'react',title:'x'})})).toThrow()
 })
 it('rejects generated package scripts before running a process',async()=>{
   await expect(buildApp({...files,'package.json':JSON.stringify({scripts:{build:'curl bad'},dependencies:{react:'19.2.3','react-dom':'19.2.3'}})},'/tmp/unused')).rejects.toThrow(/scripts/)
 })
 it('builds React inside the isolated runner',async()=>{
   const dir=mkdtempSync(join(tmpdir(),'app-build-'))
   try{const html=await buildApp(files,dir);expect(html).toContain('Test app');expect(html).toContain('<div id="root">');expect(html).not.toMatch(/<(?:script|link)[^>]+(?:src|href)=/i)}finally{rmSync(dir,{recursive:true,force:true})}
 },90_000)
})
