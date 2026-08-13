export interface WorkflowSkill { id: string; name: string; description: string; approval: 'always' | 'policy' | 'never'; tools: string[] }
export interface WorkflowConnector { id: string; name: string; mode: 'simulated' | 'configured'; classification: string }
export interface WorkflowPack { id: string; name: string; version: string; description: string; roles: string[]; skills: WorkflowSkill[]; connectors: WorkflowConnector[] }

export const CAPE_WORKFLOW_PACK: WorkflowPack = {
  id: 'cape-business-operations', name: 'CAPE Business Operations', version: '0.1.0',
  description: 'Prototype workflows for personnel, budget, staffing, coordination, and records operations.',
  roles: ['CAPE Analyst', 'Action Officer', 'Budget Reviewer', 'Records Manager', 'Workspace Administrator'],
  skills: [
    { id: 'personnel-action', name: 'Personnel Action Intake', description: 'Validate and route civilian, military, and contractor actions.', approval: 'always', tools: ['documents', 'records'] },
    { id: 'budget-execution', name: 'Budget Formulation & Execution', description: 'Reconcile budget artifacts and prepare review-ready variance analysis.', approval: 'policy', tools: ['data', 'documents'] },
    { id: 'coordination-package', name: 'Coordination Package', description: 'Assemble, staff, revise, and archive standard and custom coordination actions.', approval: 'always', tools: ['browser', 'documents', 'records'] },
    { id: 'decision-support', name: 'Decision Support', description: 'Synthesize released evidence into traceable options and decision products.', approval: 'policy', tools: ['search', 'documents', 'evidence'] },
  ],
  connectors: [
    { id: 'icompass', name: 'iCompass', mode: 'simulated', classification: 'CUI' },
    { id: 'dcpds', name: 'DCPDS', mode: 'simulated', classification: 'CUI//PRVCY' },
    { id: 'dai', name: 'Defense Agencies Initiative', mode: 'simulated', classification: 'CUI' },
    { id: 'diss', name: 'Defense Information System for Security', mode: 'simulated', classification: 'CUI//PRVCY' },
  ],
}
