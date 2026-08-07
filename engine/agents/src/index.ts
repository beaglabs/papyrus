/**
 * @papyrus/agents — persona-driven agent definitions and skill execution.
 *
 * Each persona has a system prompt, a set of tools it can invoke,
 * and produces structured output that the canvas can render as nodes.
 * Skills are packaged agent workflows that consume upstream artifacts
 * and produce new ones.
 */
export {
  createPersonaAgent,
  extractArtifact,
  type PersonaAgent,
  type AgentMessage,
  type AgentResponse,
  type CanvasNode,
} from './persona.js'
export { PERSONA_PROMPTS, TEMPLATE_PRESETS, type TemplatePreset } from './prompts.js'
export {
  runSkill,
  getSkillSpec,
  listSkills,
  type SkillInput,
  type SkillOutput,
  type SkillRunResult,
} from './skill-runner.js'
