import type { PublicState } from "./types.js";
// Public data only. Control tokens and supervisor addresses never belong here.
export function environmentDescriptor(state: PublicState): EnvironmentDescriptor {
  if (!state?.instanceId || !state?.projectId || !state?.worktreeId)
    throw new Error('This launcher does not support environment descriptors. Restart Benzo.');
  return {
    schemaVersion: 1,
    kind: 'benzo-environment',
    projectId: state.projectId,
    worktreeId: state.worktreeId,
    instanceId: state.instanceId,
    name: state.name,
    status: state.status,
    startedAt: state.startedAt,
    owner: { kind: 'benzo-launcher', lifetime: 'launcher-connection' },
    services: Object.entries(state.urls).map(([name, origin]) => ({
      id: `${state.worktreeId}/${name}`,
      name,
      origin: String(origin),
      upstream: { host: '127.0.0.1', port: Number(state.ports[name]) },
      readiness: state.status === 'ready' ? 'ready' : 'not-ready',
    })),
  };
}

export interface EnvironmentDescriptor { schemaVersion: 1; kind: "benzo-environment"; projectId: string; worktreeId: string; instanceId: string; name: string; status: string; startedAt: string; owner: { kind: "benzo-launcher"; lifetime: "launcher-connection" }; services: Array<{ id: string; name: string; origin: string; upstream: { host: string; port: number }; readiness: "ready" | "not-ready" }>; }
