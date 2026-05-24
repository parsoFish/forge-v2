import { ArtifactPage } from '@/components/ArtifactPage';

/**
 * /plan/<cycleId> — operator's quick read of the architect's PLAN.md
 * artifact for a given cycle. Linked from the verdict form.
 */
export default function Page({ params }: { params: { cycleId: string } }): JSX.Element {
  const cycleId = decodeURIComponent(params.cycleId);
  return (
    <ArtifactPage
      cycleId={cycleId}
      kind="plan"
      filename="PLAN.md"
      title="forge — plan"
      emptyHint="No PLAN.md is filed for this cycle yet. The architect writes one to _logs/<cycleId>/artifacts/PLAN.md once it converges."
    />
  );
}
