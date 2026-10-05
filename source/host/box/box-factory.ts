import { LoopbackSandBox, type LoopbackSandBoxOptions } from "./loopback-sand-box.js";
import type { ShellAccessor } from "./box-capabilities.js";

export function createSandBox<Accessor extends ShellAccessor>(options: LoopbackSandBoxOptions<Accessor>): LoopbackSandBox<Accessor> { return new LoopbackSandBox(options); }
export function formatSandBoxStartupSummary(args: { autoUpdateEnabled: boolean; isPackaged: boolean }): string { return `[sand-host] agent box backend: loopback (in-box); image: host's own container; auto-update: ${args.autoUpdateEnabled ? "on" : "off"}; build: ${args.isPackaged ? "packaged" : "dev"}`; }