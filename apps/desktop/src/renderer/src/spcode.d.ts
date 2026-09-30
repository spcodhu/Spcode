import type { SpcodeApi } from "../../preload/index";

declare global {
  interface Window {
    spcode: SpcodeApi;
  }
}
