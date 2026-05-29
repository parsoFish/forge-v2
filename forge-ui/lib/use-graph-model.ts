/**
 * Shared derivation of the pipeline graph model from the event stream.
 *
 * Lifted out of app/page.tsx (Phase B) so both the live graph
 * (AgentGraphCanvas) and the file heatmap consume ONE derivation rather
 * than re-deriving in each component. Pure functions + a thin memo hook —
 * unit-testable without the React tree.
 */

import { useMemo } from 'react';
import type { EventLogEntry, InitiativeFeature } from './bridge-client';
import type { WiGraph } from './wi-graph';
import { derivePhaseStates, type PhaseState } from './phases';
import { derivePerWiStatus, rollupStatus, type WiStatus } from './wi-status';

export type GraphWorkItem = {
  id: string;
  title: string;
  featureId?: string;
  dependsOn: string[];
  status?: WiStatus;
};

export type GraphModel = {
  phaseStates: PhaseState[];
  materialisedFeatures: InitiativeFeature[];
  workItems: GraphWorkItem[];
  featureStatuses: Record<string, WiStatus>;
};

export type GraphModelInputs = {
  events: EventLogEntry[];
  features: InitiativeFeature[];
  wiGraph: WiGraph | null;
};

/**
 * Features materialise only once their `pm.feature-decomposed` event has
 * fired; WIs only once `pm.work-item-emitted` has fired. Pre-PM, both are
 * empty. Mirrors the operator note 2026-05-25 event-driven materialisation.
 */
export function deriveGraphModel({ events, features, wiGraph }: GraphModelInputs): GraphModel {
  const phaseStates = derivePhaseStates(events);

  const ackedFeatures = new Set<string>();
  for (const e of events) {
    if (e.message !== 'pm.feature-decomposed') continue;
    const fid = (e.metadata as { feature_id?: string } | undefined)?.feature_id;
    if (fid) ackedFeatures.add(fid);
  }
  const materialisedFeatures =
    features.length === 0 || ackedFeatures.size === 0
      ? []
      : features.filter((f) => ackedFeatures.has(f.featureId));

  const wiFeature = new Map<string, string | undefined>();
  for (const e of events) {
    if (e.message !== 'pm.work-item-emitted') continue;
    const wid = (e.metadata as { work_item_id?: string } | undefined)?.work_item_id;
    const fid = (e.metadata as { feature_id?: string } | undefined)?.feature_id;
    if (wid) wiFeature.set(wid, fid);
  }

  let workItems: GraphWorkItem[] = [];
  if (wiFeature.size > 0) {
    const titleByWi = new Map<string, string>();
    const depsByWi = new Map<string, string[]>();
    if (wiGraph) {
      for (const n of wiGraph.nodes) titleByWi.set(n.id, n.label);
      for (const edge of wiGraph.edges) {
        const arr = depsByWi.get(edge.to) ?? [];
        arr.push(edge.from);
        depsByWi.set(edge.to, arr);
      }
    }
    const wiIds = Array.from(wiFeature.keys());
    const statusById = derivePerWiStatus(events, wiIds);
    workItems = Array.from(wiFeature.entries()).map(([id, featureId]) => ({
      id,
      title: titleByWi.get(id) ?? id,
      featureId,
      dependsOn: depsByWi.get(id) ?? [],
      status: statusById[id],
    }));
  }

  const wisByFeature = new Map<string, WiStatus[]>();
  for (const w of workItems) {
    if (!w.featureId) continue;
    const arr = wisByFeature.get(w.featureId) ?? [];
    if (w.status) arr.push(w.status);
    wisByFeature.set(w.featureId, arr);
  }
  const featureStatuses: Record<string, WiStatus> = {};
  for (const [fid, statuses] of wisByFeature.entries()) {
    featureStatuses[fid] = rollupStatus(statuses);
  }

  return { phaseStates, materialisedFeatures, workItems, featureStatuses };
}

export function useGraphModel(inputs: GraphModelInputs): GraphModel {
  const { events, features, wiGraph } = inputs;
  return useMemo(
    () => deriveGraphModel({ events, features, wiGraph }),
    [events, features, wiGraph],
  );
}
