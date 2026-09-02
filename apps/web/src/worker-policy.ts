// Papyrus's CSP deliberately forbids blob: workers. Chromium blocks them
// asynchronously, which troika (reagraph label rendering) cannot detect, so its
// worker dies mid-init and takes the WebGL scene with it. Failing the probe
// synchronously makes troika fall back to main-thread text rendering instead.
const NativeWorker = window.Worker

class PolicyBlockedWorker extends NativeWorker {
  constructor(scriptURL: string | URL, options?: WorkerOptions) {
    if (String(scriptURL).startsWith('blob:')) {
      throw new DOMException('blob: workers are disabled by content security policy', 'SecurityError')
    }
    super(scriptURL, options)
  }
}

window.Worker = PolicyBlockedWorker as typeof Worker
