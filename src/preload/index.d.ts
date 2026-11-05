import type { PrismBridge } from '@shared/ipc'

declare global {
  interface Window {
    prism: PrismBridge
  }
}
