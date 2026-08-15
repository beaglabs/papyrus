import { BriefcaseBusiness, GitBranch, Users } from 'lucide-react'
const data = {
  Workflows: {
    icon: GitBranch,
    eyebrow: 'GOVERNED AUTOMATION',
    title: 'Business workflows',
    description:
      'Human and agent work follows explicit plans, approvals, evidence, and records policy.',
    items: [
      ['Personnel action review', '2 approvals · DCPDS simulated'],
      ['Budget execution package', 'DAI simulated · protected write'],
      ['Contract coordination', '4 active tasks · records assigned'],
    ],
  },
  People: {
    icon: Users,
    eyebrow: 'ROLE-BASED ACCESS',
    title: 'People & roles',
    description: 'Access follows organization, workzone, data designation, and duty role.',
    items: [
      ['Local User', 'Operator · CAC/OIDC ready'],
      ['CAPE Reviewer', 'Human approval authority'],
      ['Records Manager', 'Schedules, holds, and disposition'],
    ],
  },
  'Budget & Contracts': {
    icon: BriefcaseBusiness,
    eyebrow: 'CAPE OPERATIONS',
    title: 'Budget & contracts',
    description: 'Track controlled budget and acquisition work with source-system provenance.',
    items: [
      ['FY27 operating plan', 'Draft · $4.2M'],
      ['Acquisition request AR-026', 'Awaiting approval'],
      ['Purchase reconciliation', 'DAI simulated · 12 records'],
    ],
  },
} as const
export function OperationsPanel({ section }: { section: keyof typeof data }) {
  const view = data[section]
  const Icon = view.icon
  return (
    <div className="catalog-page">
      <header>
        <Icon size={28} />
        <div>
          <span>{view.eyebrow}</span>
          <h1>{view.title}</h1>
          <p>{view.description}</p>
        </div>
      </header>
      <div className="operations-grid">
        {view.items.map(([title, detail], index) => (
          <article key={title}>
            <span>0{index + 1}</span>
            <h2>{title}</h2>
            <p>{detail}</p>
            <button type="button">Open workspace</button>
          </article>
        ))}
      </div>
    </div>
  )
}
