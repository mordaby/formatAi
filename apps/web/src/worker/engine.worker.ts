// The engine's Web Worker entry (SPEC 2, 4). Bundled by Vite as its own chunk via
// `new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' })`
// (see engineClient.ts). No network code lives here; see runtime.ts / engineMethods.ts.
import { engineMethods } from './engineMethods';
import { serveMethods, type WorkerScopeLike } from './runtime';

serveMethods(self as unknown as WorkerScopeLike, engineMethods);
