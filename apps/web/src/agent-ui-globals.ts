// Agent.tsx historically kept this formatter at the bottom of the module. The session-step
// extraction still calls it when a tool has no specialized label. Keep the binding available
// to the browser module graph and to direct Agent.tsx test imports until the agent transcript
// helpers are split into their own module.
declare global {
  var humanize: (value: string) => string
}

globalThis.humanize = (value: string) => value.replaceAll('_', ' ').replace(/([a-z])([A-Z])/g, '$1 $2')

export {}
