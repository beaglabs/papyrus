/**
 * Vendored copy of papyrus-extension-sdk (packages/extension-sdk/src/index.ts).
 * The stable core<->extension contract. Vendored into the web app until the pack
 * is consumed as a workspace dependency (needs a pnpm-lock.yaml regeneration);
 * keep byte-faithful to the pack so the swap to a package import is mechanical.
 */

/**
 * papyrus-extension-sdk
 *
 * The stable contract between the Papyrus core runtime and out-of-core
 * extension packages (papyrus-gnss and future domain packs). Extensions are
 * first-party or stakeholder-authored packages that add read-only agent tools
 * and their UI renderers without modifying the hardened core.
 *
 * Framework-free by design: this package has no runtime dependencies and does
 * not import React or Mastra. The core wires providers into its own createTool
 * and React layers through the small helpers below.
 */

export type JsonSchema = Record<string, unknown>

/** A single agent tool contributed by an extension. Must be side-effect free. */
export interface ExtensionTool {
  /** Unique tool id (also the Mastra tool id and the `tool-<id>` UI part). */
  id: string
  description: string
  /** JSON Schema for the tool input, matching the core createTool contract. */
  inputSchema: JsonSchema
  /**
   * Declared authority. Extensions may only contribute read-only tools; the
   * core enforces this at load time via `assertSafe` in collectExtensionTools.
   */
  authority?: 'read_only'
  /** Pure execution: parse/compute and return a `kind`-tagged UI object. */
  execute: (input: Record<string, unknown>) => unknown | Promise<unknown>
}

export interface ExtensionToolProvider {
  name: string
  version: string
  tools: ReadonlyArray<ExtensionTool>
}

export interface CollectToolsOptions {
  /**
   * Called for every tool id before it is accepted. The core passes its
   * `assertAgentSafeTool` gate here so an extension can never register a tool
   * whose id is on the forbidden (authority-bearing) list.
   */
  assertSafe?: (id: string) => void
}

/**
 * Flatten providers into a de-duplicated, authority-gated tool list. Throws on
 * a duplicate id so two extensions cannot silently shadow each other, and on a
 * non-read-only authority so extensions can never widen the agent's reach.
 */
export function collectExtensionTools(
  providers: ReadonlyArray<ExtensionToolProvider>,
  options: CollectToolsOptions = {},
): ReadonlyArray<ExtensionTool> {
  const tools: ExtensionTool[] = []
  const seen = new Set<string>()
  for (const provider of providers) {
    for (const tool of provider.tools) {
      if (seen.has(tool.id)) {
        throw new Error(`Duplicate extension tool id "${tool.id}" (provider ${provider.name})`)
      }
      if (tool.authority !== undefined && tool.authority !== 'read_only') {
        throw new Error(`Extension tool "${tool.id}" declares non-read-only authority; extensions must be read-only`)
      }
      seen.add(tool.id)
      options.assertSafe?.(tool.id)
      tools.push(tool)
    }
  }
  return tools
}

/* ---------- UI contract (generic over the host's component type) ---------- */

/**
 * A renderer for one `kind`-tagged tool output. `Component` is the host's
 * component type (e.g. a React FC), kept generic so this package needs no React
 * dependency.
 */
export interface ExtensionUiCard<Component> {
  kind: string
  component: Component
}

export interface ExtensionUiProvider<Component> {
  name: string
  version: string
  cards: ReadonlyArray<ExtensionUiCard<Component>>
}

export type CardRegistry<Component> = Record<string, Component>

/**
 * Build a `kind -> component` lookup from UI providers. Throws on a duplicate
 * kind so two renderers cannot silently collide.
 */
export function buildCardRegistry<Component>(
  providers: ReadonlyArray<ExtensionUiProvider<Component>>,
): CardRegistry<Component> {
  const registry: CardRegistry<Component> = {}
  for (const provider of providers) {
    for (const card of provider.cards) {
      if (card.kind in registry) {
        throw new Error(`Duplicate extension UI card kind "${card.kind}" (provider ${provider.name})`)
      }
      registry[card.kind] = card.component
    }
  }
  return registry
}
