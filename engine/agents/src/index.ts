/**
 * @papyrus/agents — single code-generation agent.
 *
 * The agent takes user prompts and project context, generates code,
 * and produces structured output that the canvas can render as nodes.
 */
export {
  createPersonaAgent,
  extractArtifacts,
  type PersonaAgent,
  type AgentMessage,
  type AgentResponse,
  type CanvasNode,
  type PersonaAgentOptions,
  buildSystemPrompt,
} from './persona.js'
export { AGENT_PROMPT, TEMPLATE_PRESETS, type TemplatePreset } from './prompts.js'
export {
  routeAgentRequest,
  type OrchestrationRoute,
} from './orchestrator.js'
export {
  runSkill,
  getSkillSpec,
  listSkills,
  type SkillInput,
  type SkillOutput,
  type SkillRunResult,
} from './skill-runner.js'
export {
  generateModelText,
  resolveModelProvider,
  type ModelProviderConfig,
} from './model-provider.js'
export {
  scaffoldProject,
  scaffoldToolDescriptions,
  selectScaffoldTool,
  type ScaffoldKind,
  type ScaffoldProject,
} from './scaffolds.js'
