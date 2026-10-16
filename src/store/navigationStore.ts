import { create } from 'zustand'
import { useAppShellStore } from './appShellStore'
import { useCatalogStore } from './catalogStore'

// Back/forward history lives in two stores: the app shell (which view is
// open) and the catalog (search → artist → album inside Explore). This
// controller records which of them took each step, so the global back and
// forward buttons replay steps in the order the user actually made them.

type Step = 'shell' | 'catalog'

interface NavigationState {
  canGoBack: boolean
  canGoForward: boolean
  goBack: () => void
  goForward: () => void
}

let backSteps: Step[] = []
let forwardSteps: Step[] = []
let replayingForward = false

/** Grows or shrinks `steps` so it holds exactly `target` entries of `step`, adding/removing at the top. */
function fit(steps: Step[], step: Step, target: number): { steps: Step[]; added: boolean } {
  const next = [...steps]
  let count = next.filter((s) => s === step).length
  const added = count < target
  while (count > target) {
    next.splice(next.lastIndexOf(step), 1)
    count--
  }
  while (count < target) {
    next.push(step)
    count++
  }
  return { steps: next, added }
}

function reconcile() {
  const shell = useAppShellStore.getState()
  const catalog = useCatalogStore.getState()

  const shellBack = fit(backSteps, 'shell', shell.history.length)
  const catalogBack = fit(shellBack.steps, 'catalog', catalog.history.length)
  backSteps = catalogBack.steps
  forwardSteps = fit(fit(forwardSteps, 'shell', shell.future.length).steps, 'catalog', catalog.future.length).steps

  // A fresh navigation (not a forward replay) invalidates everything ahead of it.
  if ((shellBack.added || catalogBack.added) && !replayingForward && forwardSteps.length > 0) {
    shell.clearForward()
    catalog.clearForward()
    return // clearing re-enters reconcile, which publishes the final state
  }

  const canGoBack = backSteps.length > 0
  const canGoForward = forwardSteps.length > 0
  const current = useNavigationStore.getState()
  if (current.canGoBack !== canGoBack || current.canGoForward !== canGoForward) {
    useNavigationStore.setState({ canGoBack, canGoForward })
  }
}

function storeFor(step: Step) {
  return step === 'shell' ? useAppShellStore.getState() : useCatalogStore.getState()
}

export const useNavigationStore = create<NavigationState>(() => ({
  canGoBack: false,
  canGoForward: false,

  goBack: () => {
    const step = backSteps[backSteps.length - 1]
    if (step) storeFor(step).goBack()
  },

  goForward: () => {
    const step = forwardSteps[forwardSteps.length - 1]
    if (!step) return
    replayingForward = true
    try {
      storeFor(step).goForward()
    } finally {
      replayingForward = false
    }
  },
}))

useAppShellStore.subscribe(reconcile)
useCatalogStore.subscribe(reconcile)
reconcile()
