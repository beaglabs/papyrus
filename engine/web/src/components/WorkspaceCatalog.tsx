import { CAPE_WORKFLOW_PACK } from '@papyrus/core/workflows/cape'
import { Bot, Cable, CheckCircle2, Sparkles } from 'lucide-react'
import { DocumentProcessingAdmin } from './DocumentProcessingAdmin'
import { IntakeSecurityAdmin } from './IntakeSecurityAdmin'

export function WorkspaceCatalog({ section }: { section: string }) {
  if (section === 'Agents')
    return (
      <div className="catalog-page">
        <header>
          <Bot size={28} />
          <div>
            <span>WORKFLOW PACK</span>
            <h1>CAPE agents</h1>
            <p>Role-bounded agents share released context, approved tools, and auditable goals.</p>
          </div>
        </header>
        <div className="catalog-grid">
          {CAPE_WORKFLOW_PACK.roles.map((role) => (
            <article key={role}>
              <Bot size={22} />
              <h2>{role}</h2>
              <p>Uses local Phi models and pauses before protected actions.</p>
              <b>LOCAL · CONTROLLED</b>
            </article>
          ))}
        </div>
      </div>
    )
  if (section === 'Skills')
    return (
      <div className="catalog-page">
        <header>
          <Sparkles size={28} />
          <div>
            <span>REUSABLE CAPABILITY</span>
            <h1>CAPE Skills</h1>
            <p>Instructions, tools, schemas, and approval policy packaged for reuse.</p>
          </div>
        </header>
        <div className="catalog-list">
          {CAPE_WORKFLOW_PACK.skills.map((skill) => (
            <article key={skill.id}>
              <div>
                <h2>{skill.name}</h2>
                <p>{skill.description}</p>
              </div>
              <span>{skill.tools.join(' · ')}</span>
              <b>{skill.approval} approval</b>
            </article>
          ))}
        </div>
      </div>
    )
  if (section === 'Connections')
    return (
      <div className="catalog-page">
        <header>
          <Cable size={28} />
          <div>
            <span>ENTERPRISE ADAPTERS</span>
            <h1>Connections</h1>
            <p>
              Prototype adapters are simulated until customer access and authorization are provided.
            </p>
          </div>
        </header>
        <div className="catalog-list">
          {CAPE_WORKFLOW_PACK.connectors.map((connector) => (
            <article key={connector.id}>
              <div>
                <h2>{connector.name}</h2>
                <p>{connector.classification}</p>
              </div>
              <span>
                <CheckCircle2 size={14} /> {connector.mode}
              </span>
              <b>adapter boundary</b>
            </article>
          ))}
        </div>
      </div>
    )
  if (section === 'Admin')
    return (
      <div className="administration-stack">
        <DocumentProcessingAdmin />
        <IntakeSecurityAdmin />
      </div>
    )
  return (
    <div className="workspace-section-placeholder">
      <h1>{section}</h1>
      <p>
        Identity, model endpoints, retention, records policy, and audit configuration are
        administered locally.
      </p>
    </div>
  )
}
