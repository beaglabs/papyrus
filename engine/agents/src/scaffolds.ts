export type ScaffoldKind =
  | 'scaffold_webapp'
  | 'scaffold_cli_ts'
  | 'scaffold_cli_py'
  | 'scaffold_api_rust'
  | 'scaffold_api_zig'

export interface ScaffoldFile {
  path: string
  content: string
  language?: string
}

export interface ScaffoldProject {
  kind: ScaffoldKind
  entrypoint: string
  template: 'react-ts' | 'vanilla-ts' | 'vanilla'
  files: ScaffoldFile[]
}

const openApi = (title: string) => `openapi: 3.1.0
info:
  title: ${title}
  version: 0.1.0
paths:
  /health:
    get:
      operationId: getHealth
      summary: Service health
      responses:
        '200':
          description: Healthy
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Health'
components:
  schemas:
    Health:
      type: object
      required: [status]
      properties:
        status:
          type: string
          const: ok
`

const file = (path: string, content: string, language?: string): ScaffoldFile => ({
  path,
  content,
  language,
})

function webapp(): ScaffoldProject {
  return {
    kind: 'scaffold_webapp',
    entrypoint: '/src/main.tsx',
    template: 'react-ts',
    files: [
      file('/openapi.yaml', openApi('Web application API'), 'yaml'),
      file(
        '/package.json',
        JSON.stringify(
          {
            scripts: { start: 'vite', build: 'tsc -b && vite build' },
            dependencies: {
              '@vitejs/plugin-react': 'latest',
              clsx: 'latest',
              'lucide-react': 'latest',
              react: 'latest',
              'react-dom': 'latest',
              'tailwind-merge': 'latest',
              vite: 'latest',
            },
            devDependencies: { typescript: 'latest' },
          },
          null,
          2,
        ),
        'json',
      ),
      file(
        '/index.html',
        '<div id="root"></div><script type="module" src="/src/main.tsx"></script>',
        'html',
      ),
      file(
        '/components.json',
        JSON.stringify(
          {
            $schema: 'https://ui.shadcn.com/schema.json',
            style: 'new-york',
            rsc: false,
            tsx: true,
            aliases: { components: '@/components', utils: '@/lib/utils', ui: '@/components/ui' },
          },
          null,
          2,
        ),
        'json',
      ),
      file(
        '/src/lib/utils.ts',
        "import { clsx, type ClassValue } from 'clsx'\nimport { twMerge } from 'tailwind-merge'\nexport function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)) }\n",
        'typescript',
      ),
      file(
        '/src/components/ui/button.tsx',
        "import type { ButtonHTMLAttributes } from 'react'\nimport { cn } from '../../lib/utils'\nexport function Button({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) { return <button className={cn('button', className)} {...props} /> }\n",
        'tsx',
      ),
      file(
        '/src/components/ui/card.tsx',
        "import type { HTMLAttributes } from 'react'\nimport { cn } from '../../lib/utils'\nexport function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) { return <div className={cn('card', className)} {...props} /> }\n",
        'tsx',
      ),
      file(
        '/src/App.tsx',
        "import { ArrowUpRight } from 'lucide-react'\nimport { Button } from './components/ui/button'\nimport { Card } from './components/ui/card'\nexport default function App() { return <main><nav><strong>Product</strong><span>Overview&nbsp;&nbsp;Docs</span></nav><section className='hero'><p className='eyebrow'>READY TO SHAPE</p><h1>Start with a strong foundation.</h1><p className='lede'>Describe the product and the engineering agent will adapt this runnable scaffold.</p><Button>Get started <ArrowUpRight size={16}/></Button></section><section className='grid'>{['Typed','Accessible','OpenAPI-first'].map(x => <Card key={x}><h2>{x}</h2><p>Production-oriented defaults, ready for focused iteration.</p></Card>)}</section></main> }\n",
        'tsx',
      ),
      file(
        '/src/main.tsx',
        "import React from 'react'\nimport { createRoot } from 'react-dom/client'\nimport App from './App'\nimport './styles.css'\ncreateRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)\n",
        'tsx',
      ),
      file(
        '/src/styles.css',
        ':root{font-family:Inter,ui-sans-serif,system-ui;color:#111;background:#f5f1e8}*{box-sizing:border-box}body{margin:0}main{min-height:100vh;padding:28px 6vw}nav{display:flex;justify-content:space-between;border-bottom:1px solid #bbb;padding:0 0 20px}.hero{max-width:850px;padding:12vh 0 8vh}.eyebrow{font:700 12px ui-monospace;letter-spacing:.18em;color:#e4512b}h1{font-size:clamp(48px,8vw,104px);line-height:.9;letter-spacing:-.06em;margin:18px 0}.lede{font-size:20px;max-width:600px;line-height:1.5}.button{display:inline-flex;gap:8px;align-items:center;border:2px solid #111;background:#e4512b;color:#fff;padding:13px 18px;font-weight:800;box-shadow:4px 4px #111}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}.card{background:#fff;border:1px solid #aaa;padding:24px;min-height:150px}@media(max-width:700px){.grid{grid-template-columns:1fr}}',
        'css',
      ),
    ],
  }
}

function cliTs(): ScaffoldProject {
  return {
    kind: 'scaffold_cli_ts',
    entrypoint: '/src/index.ts',
    template: 'vanilla-ts',
    files: [
      file('/openapi.yaml', openApi('TypeScript CLI API'), 'yaml'),
      file(
        '/package.json',
        JSON.stringify(
          {
            name: 'generated-cli',
            version: '0.1.0',
            type: 'module',
            bin: { app: './bin/run.js' },
            scripts: { build: 'tsc', test: 'node --test', start: 'oclif' },
            dependencies: { '@oclif/core': 'latest' },
            devDependencies: { oclif: 'latest', typescript: 'latest' },
            oclif: { bin: 'app', dirname: 'app', commands: './dist/commands' },
          },
          null,
          2,
        ),
        'json',
      ),
      file(
        '/tsconfig.json',
        JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2022',
              module: 'NodeNext',
              moduleResolution: 'NodeNext',
              outDir: 'dist',
              rootDir: 'src',
              strict: true,
              noUncheckedIndexedAccess: true,
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
        'json',
      ),
      file('/src/index.ts', "export { run } from '@oclif/core'\n", 'typescript'),
      file(
        '/src/commands/health.ts',
        "import { Command, Flags } from '@oclif/core'\nexport default class Health extends Command { static description = 'Check service health'; static flags = { json: Flags.boolean({ description: 'emit JSON' }) }; async run() { const { flags } = await this.parse(Health); const result = { status: 'ok' as const }; this.log(flags.json ? JSON.stringify(result) : result.status) } }\n",
        'typescript',
      ),
      file(
        '/README.md',
        '# Generated oclif CLI\n\nRun `npm install`, `npm run build`, then `./bin/run.js health`. The API contract is in `openapi.yaml`.\n',
        'markdown',
      ),
    ],
  }
}

function cliPy(): ScaffoldProject {
  return {
    kind: 'scaffold_cli_py',
    entrypoint: '/src/app/main.py',
    template: 'vanilla',
    files: [
      file('/openapi.yaml', openApi('Python CLI API'), 'yaml'),
      file(
        '/pyproject.toml',
        "[build-system]\nrequires = ['hatchling']\nbuild-backend = 'hatchling.build'\n\n[project]\nname = 'generated-cli'\nversion = '0.1.0'\nrequires-python = '>=3.11'\ndependencies = ['typer>=0.16,<1']\n\n[project.scripts]\napp = 'app.main:app'\n\n[tool.ruff]\nline-length = 100\n",
        'toml',
      ),
      file('/src/app/__init__.py', '', 'python'),
      file(
        '/src/app/main.py',
        "from typing import Annotated\nimport json\nimport typer\n\napp = typer.Typer(no_args_is_help=True)\n\n@app.command()\ndef health(as_json: Annotated[bool, typer.Option('--json', help='Emit JSON')] = False) -> None:\n    \"\"\"Check service health.\"\"\"\n    result = {'status': 'ok'}\n    typer.echo(json.dumps(result) if as_json else result['status'])\n\nif __name__ == '__main__':\n    app()\n",
        'python',
      ),
      file(
        '/tests/test_cli.py',
        "from typer.testing import CliRunner\nfrom app.main import app\n\ndef test_health() -> None:\n    result = CliRunner().invoke(app, ['health'])\n    assert result.exit_code == 0\n    assert 'ok' in result.stdout\n",
        'python',
      ),
    ],
  }
}

function apiRust(): ScaffoldProject {
  return {
    kind: 'scaffold_api_rust',
    entrypoint: '/src/main.rs',
    template: 'vanilla',
    files: [
      file('/openapi.yaml', openApi('Axum API'), 'yaml'),
      file(
        '/Cargo.toml',
        "[package]\nname = 'generated-api'\nversion = '0.1.0'\nedition = '2024'\n\n[dependencies]\naxum = '0.8'\nserde = { version = '1', features = ['derive'] }\ntokio = { version = '1', features = ['macros', 'rt-multi-thread', 'signal'] }\ntower-http = { version = '0.6', features = ['trace', 'request-id'] }\ntracing-subscriber = { version = '0.3', features = ['env-filter'] }\n",
        'toml',
      ),
      file(
        '/src/main.rs',
        'use axum::{routing::get, Json, Router};\nuse serde::Serialize;\n\n#[derive(Serialize)]\nstruct Health { status: &\'static str }\n\nasync fn health() -> Json<Health> { Json(Health { status: "ok" }) }\n\n#[tokio::main]\nasync fn main() -> Result<(), Box<dyn std::error::Error>> {\n    tracing_subscriber::fmt().with_env_filter("info").init();\n    let app = Router::new().route("/health", get(health));\n    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await?;\n    axum::serve(listener, app).with_graceful_shutdown(async { let _ = tokio::signal::ctrl_c().await; }).await?;\n    Ok(())\n}\n',
        'rust',
      ),
      file(
        '/README.md',
        '# Generated Axum API\n\nRun `cargo run`; inspect `openapi.yaml` for the contract.\n',
        'markdown',
      ),
    ],
  }
}

function apiZig(): ScaffoldProject {
  return {
    kind: 'scaffold_api_zig',
    entrypoint: '/src/main.zig',
    template: 'vanilla',
    files: [
      file('/openapi.yaml', openApi('Zap API'), 'yaml'),
      file(
        '/build.zig.zon',
        '.{ .name = .generated_api, .version = "0.1.0", .minimum_zig_version = "0.14.0", .dependencies = .{ .zap = .{ .url = "git+https://github.com/zigzap/zap#v0.10.6", .hash = "zap-0.10.6" } }, .paths = .{ "build.zig", "build.zig.zon", "src", "openapi.yaml" } }\n',
        'zig',
      ),
      file(
        '/build.zig',
        'const std = @import("std");\npub fn build(b: *std.Build) void { const target = b.standardTargetOptions(.{}); const optimize = b.standardOptimizeOption(.{}); const zap = b.dependency("zap", .{ .target = target, .optimize = optimize }); const exe = b.addExecutable(.{ .name = "generated-api", .root_module = b.createModule(.{ .root_source_file = b.path("src/main.zig"), .target = target, .optimize = optimize }) }); exe.root_module.addImport("zap", zap.module("zap")); b.installArtifact(exe); const run = b.addRunArtifact(exe); b.step("run", "Run the API").dependOn(&run.step); }\n',
        'zig',
      ),
      file(
        '/src/main.zig',
        'const zap = @import("zap");\nfn onRequest(r: zap.Request) void { if (r.path) |path| { if (std.mem.eql(u8, path, "/health")) { r.setStatus(.ok); r.sendJson("{\\"status\\":\\"ok\\"}") catch return; return; } } r.setStatus(.not_found); r.sendBody("Not found") catch return; }\nconst std = @import("std");\npub fn main() !void { var listener = zap.HttpListener.init(.{ .port = 3000, .on_request = onRequest, .log = true }); try listener.listen(); zap.start(.{ .threads = 2, .workers = 1 }); }\n',
        'zig',
      ),
      file(
        '/README.md',
        '# Generated Zap API\n\nRun `zig build run`; inspect `openapi.yaml` for the contract.\n',
        'markdown',
      ),
    ],
  }
}

export function scaffoldProject(kind: ScaffoldKind): ScaffoldProject {
  switch (kind) {
    case 'scaffold_webapp':
      return webapp()
    case 'scaffold_cli_ts':
      return cliTs()
    case 'scaffold_cli_py':
      return cliPy()
    case 'scaffold_api_rust':
      return apiRust()
    case 'scaffold_api_zig':
      return apiZig()
  }
}

export const scaffoldToolDescriptions: Record<ScaffoldKind, string> = {
  scaffold_webapp:
    'Vite React TypeScript web app with shadcn-style components and high-quality responsive styling',
  scaffold_cli_ts: 'TypeScript oclif CLI with strict typing and an OpenAPI 3.1 contract',
  scaffold_cli_py:
    'Python Typer CLI with typed commands, tests, packaging, and an OpenAPI 3.1 contract',
  scaffold_api_rust:
    'Rust Axum API with Tokio, structured JSON, tracing, graceful shutdown, and OpenAPI 3.1',
  scaffold_api_zig: 'Zig Zap API with a health route and OpenAPI 3.1 contract',
}
