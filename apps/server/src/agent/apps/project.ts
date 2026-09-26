import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AppManifest, HostedApp } from '@papyrus/contracts'
import { PapyrusAgentFSFilesystem } from '../mastra/workspace-agentfs.js'
import { NonoWorkspaceSandbox } from '../mastra/workspace-nono.js'
import { hash, PolicyError } from '../policies/store.js'
import { appFilePath } from './store.js'
const require = createRequire(import.meta.url)
export type AppFiles = Record<string,string>
export async function readProject(fs:PapyrusAgentFSFilesystem,app:HostedApp):Promise<{files:AppFiles;revision:string}> {
  const files:AppFiles={}; let bytes=0
  const visit=async (path:string)=>{ for (const entry of await fs.readdir(`${app.projectRoot}${path ? '/'+path : ''}`)) {
    const name=appFilePath(path ? `${path}/${entry.name}` : entry.name)
    if (entry.type==='directory') { await visit(name); continue }
    const stat=await fs.stat(`${app.projectRoot}/${name}`)
    bytes+=stat.size
    if (Object.keys(files).length>=128 || bytes>2*1024*1024) throw new PolicyError('APP_SOURCE_TOO_LARGE','App source limit is 128 files / 2 MiB',413)
    files[name]=String(await fs.readFile(`${app.projectRoot}/${name}`,{encoding:'utf8'}))
  }}
  await visit(''); return {files,revision:hash(files)}
}
export function manifest(files:AppFiles):AppManifest {
  let data:Record<string,unknown>
  try { data=JSON.parse(files['papyrus.app.json']??'') as Record<string,unknown> } catch { throw new PolicyError('INVALID_MANIFEST','papyrus.app.json must contain valid JSON',400) }
  if (!data || data.formatVersion!==1 || data.auth!=='inherit-entra' || data.preset!=='react' || typeof data.entry!=='string' || typeof data.title!=='string' || data.title.length>160 || Object.keys(data).some(k=>!['formatVersion','auth','preset','entry','title'].includes(k))) throw new PolicyError('INVALID_MANIFEST','Expected a version 1 React manifest with inherited Entra auth',400)
  appFilePath(data.entry)
  if (!files[data.entry]) throw new PolicyError('ENTRY_NOT_FOUND','App entry not found',400)
  return data as unknown as AppManifest
}
export async function seedProject(fs:PapyrusAgentFSFilesystem,app:HostedApp):Promise<void> {
  const files:AppFiles={
    'papyrus.app.json':JSON.stringify({formatVersion:1,title:app.name,entry:'src/main.tsx',auth:'inherit-entra',preset:'react'},null,2),
    'src/main.tsx':`import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App';\ncreateRoot(document.getElementById('root')!).render(<App />);\n`,
    'src/App.tsx':`import React from 'react';\nexport default function App() { return <main style={{fontFamily:'system-ui',padding:40}}><h1>${app.name.replace(/[<>{}]/g,'')}</h1><p>Your authenticated app is ready to build.</p></main> }\n`,
    'package.json':JSON.stringify({private:true,dependencies:{react:'19.2.3','react-dom':'19.2.3'}},null,2),
    'papyrus.lock.json':JSON.stringify({formatVersion:1,preset:'react',react:'19.2.3',reactDom:'19.2.3'}),
  }
  for (const [name,content] of Object.entries(files)) await fs.writeFile(`${app.projectRoot}/${name}`,content,{recursive:true,overwrite:false})
}
/** Builds only the captured app files; no deployment AgentFS or credentials enter this sandbox. */
export async function buildApp(files:AppFiles,dataDir:string):Promise<string> {
  const config=manifest(files)
  const packageJson=JSON.parse(files['package.json']??'{}') as {dependencies?:Record<string,string>;devDependencies?:unknown;scripts?:unknown}
  if (packageJson.scripts || packageJson.devDependencies || JSON.stringify(packageJson.dependencies)!==JSON.stringify({react:'19.2.3','react-dom':'19.2.3'})) throw new PolicyError('UNSUPPORTED_DEPENDENCIES','App preset supports pinned React 19.2.3 and React DOM 19.2.3; custom scripts are disabled',400)
  const id=randomUUID(),fs=new PapyrusAgentFSFilesystem({dataDir,agentId:`app-build-${id}`,databasePath:join(dataDir,'.app-builds',`${id}.db`)})
  const binary=createRequire(require.resolve('esbuild')).resolve(`@esbuild/${process.platform}-${process.arch}/bin/esbuild`)
  const sandbox=new NonoWorkspaceSandbox({filesystem:fs,dataDir,readOnlyToolchainPaths:[dirname(binary)],landstripBinaryPath:(require('@landstrip/landstrip') as {binaryPath:()=>string}).binaryPath()})
  try {
    await fs.init()
    for (const [path,content] of Object.entries(files)) { appFilePath(path); await fs.writeFile(`/project/${path}`,content,{recursive:true}) }
    for (const pkg of ['react','react-dom','scheduler']) {
      const root=dirname((pkg === 'scheduler' ? createRequire(require.resolve('react-dom/package.json')) : require).resolve(`${pkg}/package.json`))
      const copy=async(relative:string)=>{for(const entry of await readdir(join(root,relative),{withFileTypes:true})) {
        if (entry.isSymbolicLink()) throw new Error('Toolchain symlink rejected')
        const name=relative ? `${relative}/${entry.name}` : entry.name
        if (entry.isDirectory()) await copy(name)
        else if (entry.isFile()) await fs.writeFile(`/project/node_modules/${pkg}/${name}`,await readFile(join(root,name)),{recursive:true})
      }}; await copy('')
    }
    await sandbox.ensureRunning()
    const result=await sandbox.executeCommand!(binary,[config.entry,'--bundle','--platform=browser','--format=iife','--jsx=automatic','--define:process.env.NODE_ENV="production"','--outfile=app.js','--log-limit=5'],{cwd:'/project',timeout:60_000,maxRetainedBytes:512*1024})
    if (result.exitCode!==0) throw new Error(`App build failed: ${result.stderr.slice(0,4000)}`)
    const js=String(await fs.readFile('/project/app.js',{encoding:'utf8'}))
    if (Buffer.byteLength(js)>8*1024*1024) throw new Error('App build exceeds 8 MiB')
    const css = await fs.exists('/project/app.css') ? String(await fs.readFile('/project/app.css',{encoding:'utf8'})) : ''
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css.replace(/<\/style/gi,'<\\/style')}</style></head><body><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></body></html>`
  } finally { await sandbox.stop(); await fs.destroy(); await rm(join(dataDir,'.app-builds',`${id}.db`),{force:true}); await rm(join(dataDir,'.app-builds',`${id}.db-wal`),{force:true}); await rm(join(dataDir,'.app-builds',`${id}.db-shm`),{force:true}) }
}
