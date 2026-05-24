import { ArtifactPage } from '@/components/ArtifactPage';

/**
 * /demo/<cycleId> — operator's quick read of the unifier's DEMO.md
 * artifact for a given cycle. Linked from the verdict form so the
 * operator can review the before/after demo without leaving forge-ui.
 */
export default function Page({ params }: { params: { cycleId: string } }): JSX.Element {
  const cycleId = decodeURIComponent(params.cycleId);
  return (
    <ArtifactPage
      cycleId={cycleId}
      kind="demo"
      filename="DEMO.md"
      title="forge — demo"
      emptyHint="No DEMO.md is filed for this cycle yet. The unifier writes one to _logs/<cycleId>/artifacts/DEMO.md once the review iteration prepares the PR."
    />
  );
}
