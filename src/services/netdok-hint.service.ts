import type { LogWorksConfig, NetdokHint } from "../types/index.ts";
import { UNSPECIFIED_PROJECT } from "./parser.service.ts";

export interface NetdokSuggestionState {
  baseKeysMissing: boolean;
  noMappings: boolean;
  unmappedProjects: string[];
}

export function netdokSuggestion(state: NetdokSuggestionState): string {
  if (state.baseKeysMissing) {
    return "Call log_works_config_setup_netdok_discover (start with apiKey only).";
  }
  if (state.noMappings) {
    return "Call log_works_config_setup_netdok_apply with at least one project mapping.";
  }
  if (state.unmappedProjects.length > 0) {
    return `Ready. Optional: map remaining projects: ${state.unmappedProjects.join(", ")}.`;
  }
  return "Ready. Run netdok tasks --apply.";
}

export function computeNetdokHint(
  config: LogWorksConfig | undefined,
  projectsInRange: Iterable<string>,
): NetdokHint | undefined {
  const netdok = config?.netdok;
  const baseKeysMissing =
    !netdok?.apiKey || !netdok?.workspaceId || !netdok?.profileId;
  const mappedKeys = Object.keys(netdok?.projects ?? {});
  const mappedSet = new Set(mappedKeys);
  const projects = [...new Set(projectsInRange)].filter(
    (project): project is string =>
      Boolean(project) && project !== UNSPECIFIED_PROJECT,
  );
  const unmappedProjects = projects
    .filter((project) => !mappedSet.has(project))
    .sort();
  const configured = !baseKeysMissing;
  if (configured && unmappedProjects.length === 0) {
    return undefined;
  }
  return {
    configured,
    unmappedProjects,
    suggestion: netdokSuggestion({
      baseKeysMissing,
      noMappings: mappedKeys.length === 0,
      unmappedProjects,
    }),
  };
}
